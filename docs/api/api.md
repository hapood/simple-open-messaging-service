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

- **Body**: `{ account, password, name? }`. User accounts are 1–30 ASCII characters,
  start with an alphanumeric character, may then contain alphanumerics, `.`, `_`, or `-`,
  and are normalized to lowercase.
- **Behavior**: creates a `User` (profile columns inline — name defaults to account) with `domain='local'`.
- **Errors**: `10002` already exists · `10010` registration disabled (admin-provisioned accounts only — the common mode).

### POST `/user/my-profile` · `/user/update-profile` · `/user/update-avatar`

- `my-profile`: current user info (password hash omitted).
- `update-profile`: `{ name?, bio? }` (handle cannot change; bumps `profileRev`).
- `update-avatar`: `multipart/form-data` `file` → validates the image, federation byte limit, and maximum 512×512 dimensions, then stores the accepted bytes unchanged as one avatar resource; returns `{ avatar }`.

### GET `/user/state-feed` — Client state feed

- **Query**: `after`, optional `through`, `take`, and `mode=full|delta`. Returns a bounded page of
  compacted thread, profile, member-profile, request, and client-state changes after the client's
  only durable device-feed cursor. `THREAD_CONTENT_HEAD` carries required `messageEndSeq` and
  `tombstoneEndSeq` high-water marks. It carries no message preview or profile-selection hint: message
  catch-up owns list presentation, and exact author profiles are resolved only when the client reads the
  corresponding message. The response carries the current feed end and the next cursor for deterministic
  catch-up.
- `GET /user/group-meta` serves a visible group's full or delta roster feed by `threadId` or account.
  Member `UPSERT` and `DEPART` items include `account`, `domain`, and the server-local `namespaceId`.
  `UPSERT.body` carries role and profile revision references; clients resolve profile content separately.
  `GROUP_PROFILE` carries only `feedId` and `body.profileRev`, without a member identity.

### POST `/user/query` · `/user/resolve` · `/user/search`

- `query`: `{ userIds: number[] }` (`@ArrayMaxSize(100)`) batch user lookup.
- `resolve` / `search`: local exact/fuzzy lookup. A foreign domain is rejected by `resolve`; federated
  exact lookup must use the temporary stream below. (`10001` not found.)

### GET `/user/resolve-federated-stream` — Temporary federated exact lookup

- **Query**: `{ account, domain }`; authenticated temporary SSE, with a 30-second server-side bound.
- If either local recognition direction is missing, the lookup explicitly starts recognition. It then
  polls signed Health with per-domain request coalescing. `available` or `degraded` confirms the peer's
  recognition, while `unavailable` does not. The profile is retrieved after the local readiness gate passes.
- Emits one terminal `resolved` or `failed` event and closes. Closing the client connection cancels client
  interest; the server-to-peer request keeps its normal bounded timeout.
- The result is an untrusted display card plus relationship status. It is never persisted and never creates
  a stub; clients may close it and start another lookup at any time.

---

## Relationship API

> Controller: [src/controller/relationship.controller.ts](../../src/controller/relationship.controller.ts) · Service: [src/relationship/relationship.service.ts](../../src/relationship/relationship.service.ts)

Friend and group requests use the same directed facts. `RelationshipIntent(A,B)` and
`RelationshipIntent(B,A)` are independent rows with independent notes. For a group relationship,
one account is the group account and the other is the member account; `authorUserId` identifies which
side authored the intent. There are no separate invite, join, friend-request, or group-membership
request tables. The former polymorphic `Invite` table has been removed. Public relationship
operations select the counterparty by Address; database intent ids are not part of the API contract.
See the [relationship intent state machine](../overview/relationship-intent-state-machine.md) for
the complete transition, pair-folding, and projection-side-effect rules.

### POST `/relationship/request` — Request a user or group relationship

- **Body**: `{ account, domain, note?: string(≤255), displayName?, avatar? }`. Use the literal domain
  `local` for a local account. For a federated Address, `displayName` is required and `avatar` is an
  optional untrusted request-card snapshot obtained by the preceding temporary resolve. Database user
  ids are not part of the client identity contract.
- **Response data**: `{ taskId: string, status: "PENDING" }`. Success means the task was durably accepted,
  not that the relationship transaction has completed. Completion arrives through the Client State Feed.
- Execution upserts the caller's directed request. A new request expires after seven days; an explicit
  resend after expiry renews the absolute expiry. `20001` friending self · `10001` target not found.
- A federated request publishes only `RELATIONSHIP_INTENT`, including the author's referenced
  `profileRev`. The receiver resolves that exact revision independently through the global profile
  resolver; there is no separate `PROFILE` State Feed event. A stable foreign identity shell and its
  immutable `ProfileVersion` may be materialized by that resolution without changing relationship
  authorization.
- The federated request endpoint and its DurableTask perform no peer discovery, recognition, or other
  network operation. The preceding exact-address resolve must already have established an active peer
  namespace. If it has not, the local transaction fails and creates no relationship request or State
  Feed item.
- No federated request id is exposed. A group account is accepted only for a federated group-join
  request; a local group relationship still requires an existing invitation.

### POST `/relationship/revoke` — Revoke a relationship or pending request

- **Body**: `{ account, domain }`, using the literal domain `local` for a local user.
- For a user Address, revokes an incoming or outgoing pending friend request, or ends an active P2P
  relationship. The conversation history is retained.
- For a federated group Address, revokes only the caller's pending group-join request. Leaving an
  active group remains a separate membership operation.
- **Response data**: `{ taskId: string, status: "PENDING" }`.

### POST `/relationship/accept` — Accept an incoming relationship request

- **Body**: `{ account, domain }`. Address selection supports local and federated user requests as
  well as local and federated group invitations.
- For a friend request, acceptance authors the caller's reverse direction. The P2P relationship is
  active only when both directed intents are effective.
- For a group invitation, the group mirror becomes active only after the origin's state snapshot
  confirms membership.
- **Response data**: `{ taskId: string, status: "PENDING" }` for durable operations.

There are no separate public reject, request-revoke, or delete-friend routes. All three user-facing
actions use `/relationship/revoke` with the counterparty Address; the server resolves the current
relationship state and dispatches the corresponding internal task. A USER→GROUP federated join
application likewise uses `/relationship/request`. GROUP→USER invitation administration remains
under `/group/*` because the group, rather than the current user, authors that direction.

- Federation convergence is asynchronous through the state feed; there are no S2S invite command
  endpoints.
- Every pending friend/group request has an absolute expiry of at most seven days. Expired requests
  are ineffective even if an old feed projection remains. REVOKED has no expiry and is retained
  best-effort.

### POST `/relationship/requests/read`

- Advances the account's incoming-request read cursor. Request lists are device projections consumed
  from `ClientStateFeed`; the server exposes no separate incoming/outgoing list API.

---

## Message API

> Controller: [src/controller/message.controller.ts](../../src/controller/message.controller.ts) · DTO: [src/dto/message.dto.ts](../../src/dto/message.dto.ts)

### POST `/send-message` — Send message

- **Body**: `{ threadId: number, content: string, contentType?: 'PURE_TEXT'|'LINK', clientMessageId?: UUID }`. Media messages use `/send-media` followed by the matching `/upload*` endpoint.
- **Behavior**: `ThreadAccessGuard` checks membership; allocates a per-thread `seq` atomically from `curSeq`; `MessageFanoutService` publishes each recipient's compacted `THREAD_CONTENT_HEAD`, wakes live clients through `STATE_FEED_UPDATED`, and notifies offline recipients through Push. `clientMessageId` is the send-idempotency key (a retry returns the original message).
- **Replies**: PURE_TEXT content is `{ "text": "...", "quote": { "seq": n } }`. A positive `n` must identify a visible message in the same local thread when sending; `0` explicitly preserves a reply with no target. Ordinary text omits `quote`. Internal federation namespaces are not client navigation coordinates.
- **Errors**: `30001` empty · `30002` not approved · `30003` thread not found.

### POST `/send-media` — Send media (staged)

- **Body**: `{ threadId, contentType: 'IMAGE'|'FILE'|'VIDEO'|'AUDIO', clientMessageId, ...display meta }`. Stages a `PendingMedia` row; the bytes land via `/upload` and are promoted to a `Message` once confirmed. (`/query-media-stages`, `/media-status`, `/relocalize-media` support the staging lifecycle.)

### POST `/send-forward` — Send an immutable forwarded-message bundle

- **Body**: `{ threadId, sourceMessages: [{ threadId, seq }], clientMessageId }` (1–100 source messages).
- **Behavior**: the server, never the client, snapshots sender display data and content into a `ForwardBundle.manifest` JSONB document. `manifest.children` is an ordered array of directly nested bundle ids; `ForwardBundleDependency` mirrors it for indexed traversal. Attachment and avatar bytes remain deduplicated CAS objects referenced by `ForwardBundleAsset`. The resulting `Message` has `contentType: 'FORWARD'`; its small JSON content contains only `bundleId`, up to three 100-grapheme summary lines and counts.
- **Depth**: a leaf bundle is depth 1 and a parent is `1 + max(child.depth)`. Maximum depth is 3. Attempting to forward an existing depth-3 card returns `30004`; the server recomputes this regardless of frontend checks.
- **History replies**: bundle text contains only `text`; `quoteTargetId` on the entry refers to a message ID in that same bundle array. Selected reply targets are remapped to those IDs; absent or unselected targets are emitted as `0`. Imported positive references without a target entry are also displayed as unavailable. DIRECT mode strips reply context.
- **Read**: `GET /forward-bundles/:bundleId` returns the visible root and its complete child closure after checking that the caller participates in a thread containing the root card.

### POST `/query-messages` — Paginated history

- **Body**: `{ threadId, after?, before?, through?, take? }`. `after` and `before` are mutually exclusive
  non-negative integer cursors. Forward pages cover `(after, through]` in ascending order; reverse pages cover
  `[through, before)` in descending order. `through` is an inclusive fixed boundary.
- Omitting both direction cursors bootstraps the query with business result `30006` and
  `{ resumeAfter, resumeBefore }`; a forward query adopts `resumeAfter`, while a reverse query adopts
  `resumeBefore`. The resume fields and successful-page `scannedThrough` are
  integer message-sequence boundaries.
- `MessageThread.clearedSeq` is an exclusive lower cursor boundary. An `after` below it or a `before`
  at/below the first remaining coordinate is rejected before the message-row query with the same
  `30006 { resumeAfter, resumeBefore }` recovery payload. The client must retry from those server-owned
  cursors; it does not merge a locally stored clear boundary into the request.
- The endpoint `through` is clipped to the visible history window in either direction. An endpoint
  beyond that window does not invalidate an otherwise valid starting cursor.

### POST `/deleted-messages/query` — Paginated tombstones

- Uses the same `{ threadId, after?, before?, through?, take?, maxMessageSeq? }` directional cursor contract as
  `/query-messages`, in the conversation's deletion-coordinate space.
- `maxMessageSeq` is used only by the first chatbox-open recovery walk. The client freezes it to the
  newest locally persisted message sequence and freezes `through` to the state head visible at open;
  the server still advances `scannedThrough` across filtered deletion coordinates. Later walks omit it.
- Omitting both cursors returns `30006 { resumeAfter, resumeBefore }`. A successful page returns
  `{ tombstones, scannedThrough, hasMore }`; each public tombstone contains
  `{ deletionSeq, threadId, messageSeq, type, createdAt, updatedAt }`. The
  direction cursors, `scannedThrough`, and `deletionSeq` are JSON integers in
  the conversation's thread-local deletion-coordinate space.

### POST `/thread/{by-user-id, mark-read, set-muted, set-pinned, set-alias}`

- Per-`AccountThreadState` mutations: the P2P thread lookup, read watermark advance, mute, pin, and per-thread alias. `search-messages` does in-chat search.

`mark-read` commits a viewport-dwelled HWM on chat close/switch:

- **Body**: `{ threadId, localReadHwm }`.
- The server stores `max(AccountThreadState.lastReadSeq, localReadHwm)` and returns
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

- **Body**: `{ groupId, users: [{ account, domain }] }` — enqueue one GROUP invitation per
  valid existing friend. The server resolves each address to the current authoritative
  identity and verifies the active P2P relationship. Resolution never creates a User
  or selects an identity copied from another peer's group. `local` and this server's
  public domain both identify local users. Duplicate normalized addresses are coalesced.
  The response contains `invited: [{ account, domain }]`,
  `tasks: [{ account, domain, taskId, status: "PENDING" }]`, and
  `skipped: [{ account, domain, reason }]`. Client-side profile lookup and candidate
  listing are optional presentation steps, not prerequisites for admission.

### Group request projections

- `POST /group/join-requests` and `POST /group/invitations` use the same newest-first request-page
  contract: `{ groupId, before?, take? }`.
- `POST /group/join-request/{accept,reject}` acts on a member-authored application.
- `POST /group/invitation/revoke` cancels a still-live group-authored invitation.
- These mutation routes return `{ taskId: string, status: "PENDING" }` after
  validation and durable acceptance.
- These lists are backend projections written after the corresponding intent fact and relationship
  fold commit. They are not membership authority.

### POST `/group/{leave, kick, transfer, set-role, update}`

- `leave` (`40004` owner must transfer first) · `kick` (`40005` forbidden,
  `40006` target not a member) · `transfer` (ownership) · `set-role`
  (ADMIN/MEMBER) return durable task acceptance. `update`
  (name/avatar/bio) remains synchronous because it is not a relationship
  mutation.

### POST `/group/dissolve`

- **Body**: `{ groupId }`. Owner-only. Conversation history is retained.
- Returns `{ taskId: string, status: "PENDING" }` after durable acceptance.
  The parent task commits the permanent dissolution marker and durably
  checkpoints one member-revoke child task per active roster member. It does
  not wait for those children to execute.

---

## Calls API

> Controller: [src/controller/calls.controller.ts](../../src/controller/calls.controller.ts) · Service: [src/calls/calls.service.ts](../../src/calls/calls.service.ts)

1:1 audio/video calls. The server is a **signaling coordinator + lifecycle owner only** — it never touches media. On a terminal state `CallsService` authors a `ContentType.CALL` chat bubble (bilateral).

- `POST /calls/initiate` `{ callSid, calleeUserId, callType }` → `{ callSid, threadId }` (`70001` not friends · `70004` busy).
- `POST /calls/{accept, ringing, connected, decline, cancel, end, signal}` drive the FSM (`70002` not found · `70003` not a participant · `70005` invalid transition).
- `GET /calls/ice-servers` — TURN/STUN helper (TURN off by default; misconfig throws).
- `GET /calls/:callSid/signaling` — caller-side answer fetch.

See the [Android calls client contract](../platform/android/calls.md).

---

## Device & Notification API

> Controllers: [device.controller.ts](../../src/controller/device.controller.ts) · [notification.controller.ts](../../src/controller/notification.controller.ts)

- `POST /devices/register` / `DELETE /devices/register/:token` — register/unregister a push token (FCM registration token for ANDROID, Web Push subscription for WEB). Registration binds the token to the current authenticated session; re-registering re-owns it to that session.
- `POST /devices/fcm-probes`, `GET /devices/fcm-probes/:probeId`, and `POST /devices/fcm-probes/:probeId/ack` — run and observe a one-off Android FCM delivery probe.
- `GET /notifications/vapid-key` (`@Public`) — Web Push VAPID public key.
- `GET /user/state-feed` — the single device-facing state feed, including paired thread content heads.
- `POST /notification-feed/query` — build an away-notification delta from changed threads. Each descriptor
  adds or replaces the notification for its thread; an empty result is a no-op.
- `POST /notifications/action` — dispatch a notification action such as mark-read or inline reply.

---

## File / Media API

> Controller: [src/upload/upload.controller.ts](../../src/upload/upload.controller.ts) · Service: [src/upload/upload.service.ts](../../src/upload/upload.service.ts)

### POST `/upload` — Upload (chat media / avatar)

- **Body**: `multipart/form-data`, field `file`; for chat media, plus `w`/`h` form fields. Allowed: jpg/png/gif/webp (magic-number validated). Size limit per type (video up to ~100 MB; `@fastify/multipart` 100 MB part cap).
- **Behavior**: writes bytes through the **content-addressed CAS pipeline** — `MediaAsset` uses sha256 of the raw bytes and stores exactly one extensionless blob at `data/cas/<dd>/<dd>/<digest>`; filename, MIME and message type remain message metadata. Avatars use a separate validated, byte-preserving single-file path. The returned `/uploads/cas/<dd>/<dd>/<digest>` URL is gated by `MediaAccessService` and only READY assets are readable.
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
- `POST /admin/threads/clear-history` `{ threadId, seq? }` — advances the thread-wide history boundary through `seq` (inclusive), or through the thread's current message sequence when omitted. Requires `ADMIN` or `SUPER_ADMIN` and is audited.
- `POST /admin/bans` · `/admin/bans/unban` `{ ip?, account? }` — list/unban login bans (the shared `BruteForceService`; one unban clears all account-keyed dims — password + OTP).
- `POST /admin/sessions` `{ skip?, take?, userId?, ip? }` · `/admin/sessions/purge` — system-wide session overview / one-click purge.
- `POST /admin/audit` — `@Audit`-tagged action log (`AdminActionLog`).
- `POST /admin/durable-tasks` — paginated durable-task execution history with status and search filters.
- Federation / quota admin: `AdminFederationController` (peer trust timeline), `AdminQuotaController` (per-peer quota overrides). Diagnostics + log viewer: `AdminDiagnosticsController`, `LogViewerController` (`/admin/logs/*`).

---

## SSE Events

> Endpoint: [src/gateway/events.controller.ts](../../src/gateway/events.controller.ts) + [src/gateway/sse.service.ts](../../src/gateway/sse.service.ts) · `GET /api/v1/events` (`text/event-stream`)

### Connection & HELLO

The browser opens the stream via a fetch-backed SSE client inside a Web Worker (the native EventSource API cannot set headers). The credential travels as the **httpOnly cookie** (browser) or `Authorization: Bearer` (native) — never in the URL. Authentication failure → HTTP 401 (no frame); the client reconnects.

On connect the server pushes a **`HELLO`** frame with `stateFeedEndId` and `activeCall`.
`stateFeedEndId` bounds catch-up for hydrated thread state (including group/roster invalidation and per-user
settings/read state), cached profile changes, source-scoped member profiles, incoming friend requests, and
paired thread content heads. Heartbeat: a `: ping` comment frame every 25s.

### Frame format

```
event: <EVENT_NAME>
data: <json>
```

### Event list (backend → frontend)

| Event                        | Purpose                                           | Recovery source                            |
| ---------------------------- | ------------------------------------------------- | ------------------------------------------ |
| `HELLO`                      | connection handshake and current high-water marks | sent on every connection                   |
| `STATE_FEED_UPDATED`         | identity-only Client State Feed wake `{ feedId }` | `HELLO.stateFeedEndId` + ranged state pull |
| `MEDIA_STATUS`               | media-localization completion wake                | message/media query                        |
| `CALL_EVENT` / `CALL_SIGNAL` | ephemeral call lifecycle and WebRTC signaling     | active-call snapshot/new negotiation       |
| `FORCE_LOGOUT`               | terminate a revoked session                       | authentication state                       |

There are no dedicated group, profile, friend/request, thread-metadata, message-head, or read-state SSE
events. Those changes are committed to the Client State Feed first and SSE carries only
`STATE_FEED_UPDATED`. Out-of-band Push may still use the payload type `NEW_MESSAGE`; it is suppressed only
for the exact device session that has a live SSE takeover, carries only `{ type, messageEndSeq }`, and is not
an SSE event. Incoming-call Push follows the same per-session takeover rule while remaining eligible on the
user's other offline devices.

> Ordering & completeness: on a live connection, strict ordering is guaranteed by TCP; state missed during a disconnect is caught up from the local Client State Feed cursor through `HELLO.stateFeedEndId`, and message bodies are caught up from per-thread cursors through each `THREAD_CONTENT_HEAD.messageEndSeq` (the stream does not replay history — no `Last-Event-ID`).

### Client → Server

SSE is unidirectional; **clients do not send business messages over SSE**. All writes (sending messages, invites, calls, future typing) go through HTTP `POST`.
