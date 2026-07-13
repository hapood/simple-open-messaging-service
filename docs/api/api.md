# API Reference

The SOMS backend listens on `http://localhost:3000` with the global prefix `/api/v1`. Unless otherwise noted, **all endpoints are `POST`** (including query-type endpoints), with JSON request bodies and a unified response format. File upload endpoints use `multipart/form-data`.

## Table of Contents

- [Common Conventions](#common-conventions)
- [Authentication API](#authentication-api)
- [User API](#user-api)
- [Message API](#message-api)
- [Group API](#group-api)
- [File API](#file-api)
- [Admin API](#admin-api)
- [SSE Events](#sse-events)

---

## Common Conventions

### Response Format

```ts
interface StandardResponse<T = any> {
  code: number;        // 0 = success; non-0 = business error code (segmented by domain, see below)
  message: string;
  data?: T;
  hasMore?: boolean;   // populated for paginated endpoints: whether more data is available
}
```

> The field is `code` (renamed from `status` as of P1a). Business results always use HTTP 200 + `code`; only unauthenticated (401) / not found (404) / conflict (409) / server error (500) retain HTTP status codes for broad categories. DTO parameter validation failures are also routed through the business flow (200 + `10000`).

### Business Error Codes

Segmented by domain prefix (aligned with the WhatsApp Cloud API). Full definitions are in [`src/common/business-code.ts`](../../src/common/business-code.ts) `BusinessCode` enum:

| Segment | Meaning | Primary codes |
| --- | --- | --- |
| `0` | Success | |
| `10xxx` | General | `10000` parameter validation / `10001` not found / `10002` already exists / `10003` unauthenticated / `10004` no permission / `10005` rate limited · IP banned / `10006` refresh reuse → forced re-login / `10007` session revoked / `10999` server error |
| `20xxx` | Friend · thread state machine | `20001` adding self as friend / `20002` unknown state / `20003` no pending request |
| `30xxx` | Message domain | `30001` empty content / `30002` thread not approved / `30003` no such thread |
| `40xxx` | Group domain | `40001` not a group member / `40002` cannot invite non-friend / `40003` invalid invite token |

> Examples: wrong login credentials → `code:10003`; IP ban → `code:10005` + `data.bannedUntil` (unban timestamp); duplicate registration → `code:10002`; refresh token reuse → `code:10006` (the entire family is revoked at the root, frontend forces re-login).
> Note: The HTTP response envelope field is `code` (see table above). The `status` below still appears in the friend request internal state machine's `status 0/1/2/3/5` (the return value of `makeFriendRequest`, not directly reflected in the response `code`).

### Authentication

- Endpoints requiring authentication expect the request header: `Authorization: Bearer <access_token>`.
- Registration, login, and renewal endpoints require no authentication (the frontend marks them with `Authorization: 'public'`; the interceptor lets them through).
- `userId` is taken from the JWT `sub` and attached to `req.user.userId`; controllers use it to identify the caller.
- **Admin endpoints** use a separate JWT (its own `adminSecret` + `scope: 'admin'` claim), guarded by `AdminAuthGuard` — physically isolated from the user system and mutually incompatible.

### Data Type Conventions

- `Date` is serialized as a **millisecond timestamp** (number).
- `msgId` (message ID) is a `BigInt`, returned as a **string**.

---

## Authentication API

> Controller: [src/controller/auth.controller.ts](../../src/controller/auth.controller.ts)

### POST `/auth/login` — Login

- **Auth**: Local (body provides `account` + `password`)
- **Request body**: `{ account: string, password: string, device?: string }` (`device` is a frontend-generated device identifier used to distinguish sessions across multiple devices)
- **Response `data`** (code=0): `{ access_token: string, refresh_token: string }`
- **Errors**: wrong credentials `code:10003`; IP ban `code:10005`, `data.bannedUntil` is the unban timestamp
- **Rate limit**: cumulative failures from the same IP >3 times bans for 30 minutes, >6 times bans for 3 hours, >9 times bans for 24 hours

### POST `/auth/renew-access` — Rotate via refresh token (family-based + reuse detection)

- **Auth**: None (`public`)
- **Request body**: `{ refreshToken: string, device?: string }`
- **Response `data`**: `{ access_token: string, refresh_token: string }` (**full rotation**: the old refresh is marked revoked `rotated`, and a new access + new refresh are issued)
- **Errors**: `code:10006` reuse detected (the family is revoked at the root; the frontend must force re-login); `code:10003` refresh invalid/expired
- **Rate limit**: `@Throttle(30, 60)`

> The naming is a historical artifact — despite being called `renew-access`, it actually performs a full access + refresh rotation (identical to the `renew-refresh` implementation; the dual names are kept only for compatibility).

### POST `/auth/renew-refresh` — refresh rotation (alias of `renew-access`)

- **Auth**: None (`public`)
- **Request body / response / behavior**: Identical to `renew-access` (same `rotateRefreshToken` implementation); the dual endpoints are retained only for backward compatibility.

### POST `/auth/logout` — Logout

- **Auth**: None (`public`; the frontend marks the header `Authorization: 'public'`, refresh_token in body)
- **Request body**: `{ refreshToken: string, accessJti?: string }`
- **Behavior**: Marks the corresponding refresh_token as revoked (`revokeReason='logout'`); if `accessJti` is provided, the current access token is **immediately** added to the jti blacklist (TTL = remaining access lifetime), achieving instant kick-offline.
- **Response**: `{ code: 0, message: 'success' }`
- **Rate limit**: `@Throttle(30, 60)`

### POST `/auth/logout-all` — Logout all devices

- **Auth**: JWT
- **Behavior**: `invalidateAllSessions(userId, 'all_devices')` — bump `User.tokenVersion` (invalidating all of that user's access tokens immediately) + revoke all their refresh tokens + clear the access jti cache, and force-disconnect all their SSE connections via the `auth.sessions-invalidated` event.
- **Response**: `{ code: 0, message: 'success' }`

### POST `/auth/change-password` — Change password

- **Auth**: JWT
- **Request body**: `{ oldPassword: string, newPassword: string }` (`newPassword` follows the same 6–20 character allowed-charset rule)
- **Behavior**: verify old password → change password → revoke **all other** sessions of this user (the current device is re-issued a new pair of tokens)
- **Response**: on success `data: { access_token, refresh_token }`; wrong old password `code:10000` (`VALIDATION_FAILED`, message=`old password wrong`)
- **Rate limit**: `@Throttle(10, 60)`

### POST `/auth/sessions` — List current user's active sessions

- **Auth**: JWT
- **Response `data`**: list of the current user's active sessions (each containing `device` / `userAgent` / `ip` / `createdAt` / `expiresAt`, etc.)

### POST `/auth/revoke-session` — Revoke a single session

- **Auth**: JWT
- **Request body**: `{ jti: string, accessJti?: string }` (`jti` must belong to the current user)
- **Behavior**: revokes the specified refresh (by `jti`); if `accessJti` is provided, also blacklists the current access.

> Session hardening details (revocable access, tokenVersion, family-based refresh + reuse detection, in-process KV, WS coordination) are in [architecture.md → Authentication](../overview/architecture.md#authentication-mechanism).

---

## User API

> Controller: [src/controller/user.controller.ts](../../src/controller/user.controller.ts)

### POST `/user/register` — Register

- **Auth**: None
- **Request body**: `{ account: string, password: string }`
- **Validation rules**:
  - `account`: `^(?=[\w.-]{1,20}$)(?:[\d_.-]*[a-zA-Z]){3}[\w.-]*$` (1–20 characters, at least 3 letters)
  - `password`: 6–20 characters, allowing alphanumeric and `.@!#$%^&*()`
- **Response `data`**: `{ id: number, account: string }`
- **Behavior**: within a transaction, creates a `User` + `UserExtra` (name defaults to account) + `userNotiBox`; `isForeigner=false`, `domain=null`.

### POST `/user/my-profile` — Current user profile

- **Auth**: JWT
- **Response `data`**: current user info (excluding password hash)

### POST `/user/update-avatar` — Update avatar

- **Auth**: JWT
- **Request body**: `multipart/form-data`, field `file` = image binary
- **Allowed formats**: jpg / png / gif / webp (magic number second-pass validation)
- **Behavior**: rewritten via `sharp` into multiple webp tiers 32/64/128/256/512 (EXIF-orientated, cover-cropped, EXIF/malicious chunks stripped, pixel cap to guard against decompression bombs); writes new tiers to disk → updates DB → deletes old tiers.
- **Response `data`**: `{ avatar: string }` (full URL of the largest 512px tier; other tiers are derived by the frontend)
- **Errors**: no file / non-image → `code:10000`

### POST `/user/update-profile` — Update nickname / bio

- **Auth**: JWT
- **Request body**: `{ name?: string, bio?: string }` (`account`/handle cannot be changed; `bio` ≤ 120 characters)
- **Response `data`**: updated user info (excluding password hash)

### POST `/user/query-thread/valid` — Valid thread list

- **Auth**: JWT
- **Request body**: `{ skip: number, take: number, lastId?: number, toObjType?: 'P2P'|'GROUP' }`
- **Response `data`**: all of the current user's `APPROVED` threads; P2P includes the peer user info, GROUP includes the group info

### POST `/user/query-thread/to-pending` — Received pending friend requests

- **Auth**: JWT
- **Request body**: `{ beforeDate: number, take: number, skip: number }`
- **Response `data`**: list of friend requests received by the current user in the `TO_PENDING` state

### POST `/user/query-thread/from-pending` — Sent pending friend requests

- **Auth**: JWT
- **Request body**: `{ beforeDate: number, take: number, skip: number }`
- **Response `data`**: list of friend requests sent by the current user in the `FROM_PENDING` state

### POST `/user/send-friend-request` — Send friend request

- **Auth**: JWT
- **Request body**: `{ userId: number }` (target user)
- **Response `code`**: `0` request sent (covers first send / already friends / re-initiate / counterpart already requested and a direct connection is established / do not disturb); `20001` adding self as friend; `20002` unknown state-machine state
- **Internal state machine**: `makeFriendRequest` returns status `0/1/2/3/5` driving the above behavior, not directly reflected in the response `code`
- **See**: [architecture.md → Friend Request State Machine](../overview/architecture.md#friend-request-state-machine)

### POST `/user/approve-friend-request` — Accept friend request

- **Auth**: JWT
- **Request body**: `{ userId: number }` (request initiator)
- **Behavior**: establishes a P2P thread (creating a `MessageThread` for the first time); both parties are set to `APPROVED`
- **Errors**: `20003` no pending request from this user

### POST `/user/decline-friend-request` — Decline friend request

- **Auth**: JWT
- **Request body**: `{ userId: number }` (request initiator)
- **Behavior**: declines the pending request received from the counterpart
- **Errors**: `20003` no pending request from this user

### POST `/user/cancel-friend-request` — Retract sent friend request

- **Auth**: JWT
- **Request body**: `{ userId: number }` (target user)
- **Behavior**: retracts a pending request already sent by the current user
- **Errors**: `20003` the current user has no pending request to this target

### POST `/user/query` — Batch query users

- **Auth**: JWT
- **Request body**: `{ userIds: number[] }` (max 100, `@ArrayMaxSize(100)`)
- **Response `data`**: user info array (`isDeleted=false`)

### POST `/user/by-uniq-name` — Query by account name

- **Auth**: JWT
- **Request body**: `{ account: string }`
- **Response `data`**: a single user's info; not found `code:10001`

### POST `/user/thread-info` — Thread details

- **Auth**: JWT
- **Request body**: `{ userThreadId: number }`
- **Response `data`**: thread details, with the corresponding user (P2P) or group (GROUP) info

---

## Message API

> Controller: [src/controller/message.controller.ts](../../src/controller/message.controller.ts)

### POST `/send-message` — Send message

- **Auth**: JWT
- **Request body**: `{ userThreadId: number, content: string }`
- **Behavior**: validates the sender's thread is `APPROVED` (P2P additionally requires the peer to be `APPROVED`), writes a `Message(PURE_TEXT)`, and pushes a `NEW_MESSAGE` to the peer/group members via **SSE** (payload is the full message body; the frontend renders it on receipt)
- **Response `data`**: contains the new message's `msgId` (string)

### POST `/query-messages` — Paginated history message query

- **Auth**: JWT
- **Request body**: `{ userThreadId: number, skip: number, take: number, lastId?: number, orderBy: 'desc'|'asc' }`
- **Behavior**: **cursor pagination** based on `MessageThread` (`lastId` + `skip` + `take`), supporting ascending/descending order
- **Response `data`**: message array (`id` as string, `createdAt` as timestamp)

### POST `/thread/by-user-id` — Query the P2P thread with a given user

- **Auth**: JWT
- **Request body**: `{ userId: number }`
- **Response `data`**: the corresponding `UserMessageThread` (if it exists)

---

## Group API

> Controller: [src/controller/group.controller.ts](../../src/controller/group.controller.ts)

### POST `/group/create` — Create group

- **Auth**: JWT
- **Request body**: `{ groupName: string }` (max 31 characters)
- **Behavior**: within a transaction, creates a `MessageThread(GROUP)` → `Group` (owner, threadId) → the creator's `UserMessageThread(APPROVED)` + `GroupMember`
- **Response `data`**: `{ threadId: number, groupId: number }`

### POST `/group/invite` — Invite a friend to a group

- **Auth**: JWT
- **Request body**: `{ userId: number, groupId: number }`
- **Pre-validation**: inviter is a group member, invitee is a friend (both `APPROVED`)
- **Behavior**: writes an `INVITE` message to the P2P thread between the two, with JSON content:
  ```json
  {
    "type": "GROUP_INVITE",
    "fromUserId": 1,
    "groupName": "Group Name",
    "expiryDate": 1719000000000,
    "token": "<JWT, sub=invitee, gid=group, valid 3 days>"
  }
  ```

### POST `/group/join` — Join a group via invite token

- **Auth**: JWT
- **Request body**: `{ token: string }`
- **Behavior**: decodes the invite token (validates `sub` = current user, not expired) → creates `GroupMember` + `UserMessageThread(APPROVED)`

### POST `/group/info` — Group info

- **Auth**: JWT
- **Request body**: `{ groupId: number }`
- **Response `data`**: group info

---

## File API

> Controller: [src/upload/upload.controller.ts](../../src/upload/upload.controller.ts) · Service: [src/upload/upload.service.ts](../../src/upload/upload.service.ts)

### POST `/upload` — Upload image (chat album)

- **Auth**: JWT
- **Request body**: `multipart/form-data`, field `file` = image binary; plus form fields `w` / `h` (width/height read by the frontend's `createImageBitmap`; the backend preserves as-is without parsing the image content)
- **Allowed formats**: jpg / jpeg / png / gif / webp (multer `fileFilter` mimetype coarse filter + `isImage` reading the file header magic number to prevent spoofing)
- **Size limit**: 10MB
- **Behavior**: `multer` memoryStorage → magic number validation → write to disk at `process.cwd()/uploads/<ts>-<rand>.<ext>` → return a reachable URL
- **Response `data`**: `{ url: string, w: number, h: number }` (`url` is of the form `/uploads/...`, served statically via `main.ts`'s `useStaticAssets`)
- **Errors**: no file `code:10000` message=`no file`; non-genuine image `code:10000` message=`invalid image`

> Avatar uploads do not go through this endpoint; they use [`/user/update-avatar`](#post-userupdate-avatar--update-avatar) (`sharp` server-side rewrites into multiple webp tiers).
> When switching to object storage (S3/OSS/MinIO) in production, only the `save()` / `saveAvatars()` write targets and url generation change; the API contract stays the same.

---

## Admin API

> Controller: [src/admin/admin.controller.ts](../../src/admin/admin.controller.ts) · Service: [src/admin/admin-auth.service.ts](../../src/admin/admin-auth.service.ts)

Admin auth uses a **separate JWT system** (its own `adminSecret` + `scope: 'admin'` claim, guarded by
`AdminAuthGuard`) — admin sessions/tokens stay physically isolated from user sessions. Identity,
however, is shared: an admin is a **linked profile** on a `User` row (`Admin.userId → User.id`); the
account name and password live on the `User`, and `/admin/login` verifies `User.hashPwd` then issues
an admin session. One account namespace → a user and an admin can never share an account. All admin
endpoints except `admin/login` / `admin/renew-access` require `Authorization: Bearer <admin_access_token>`.

### Authentication

#### POST `/admin/login` — Admin login

- **Auth**: None
- **Request body**: `{ account: string, password: string }`
- **Response `data`** (code=0): `{ access_token: string, refresh_token: string }`; also updates `Admin.lastLoginAt` / `lastLoginIp`
- **Errors**: wrong credentials / disabled account → `code:10003` message=`invalid credentials`

#### POST `/admin/renew-access` — Admin refresh rotation

- **Auth**: None
- **Request body**: `{ refreshToken: string }`
- **Response `data`**: `{ access_token: string, refresh_token: string }` (family-based rotation + reuse detection)
- **Errors**: `code:10006` reuse (family revoked at the root); `code:10003` invalid

#### POST `/admin/logout` — Admin logout

- **Auth**: AdminJWT
- **Request body**: `{ refreshToken: string }`
- **Behavior**: revokes the refresh (`revokeReason='logout'`)

### User Management

#### POST `/admin/users` — User list

- **Request body**: `{ skip?: number, take?: number, search?: string }` (`search` is a case-insensitive fuzzy match against `account`)
- **Response `data`**: `{ list: User[], total: number }` (ordered by `createdAt desc`, with `hashPwd` stripped)

#### POST `/admin/users/:id/disable` — Ban user

- **Behavior**: soft delete (`isDeleted=true`) + `invalidateAllSessions(id, 'admin_disabled')` to force offline

#### POST `/admin/users/:id/enable` — Unban user

- **Behavior**: `isDeleted=false`

#### POST `/admin/users/:id/force-logout` — Force logout

- **Behavior**: `invalidateAllSessions(id, 'admin_force_logout')` (revokes all sessions of this user)

#### POST `/admin/users/:id/sessions` — View a specified user's active sessions

- **Response `data`**: list of that user's active sessions

#### POST `/admin/users/:id/reset-password` — Reset password

- **Request body**: `{ newPassword: string }` (6–20 character allowed charset)
- **Behavior**: change password + `invalidateAllSessions(id, 'admin_reset_password')` (revokes all sessions, forces re-login)

### Ban Management

> Login bans (IP / account) live in an in-process dictionary inside `LocalStrategy` — **no dedicated table**.

#### POST `/admin/bans` — List current login bans

- **Response `data`**: list of currently effective IP / account bans

#### POST `/admin/bans/unban` — Unban

- **Request body**: `{ ip?: string, account?: string }` (at least one must be provided)

### Audit

#### POST `/admin/reuse-alerts` — refresh token reuse alerts

- **Request body**: `{ take?: number }` (default 50)
- **Response `data`**: records in `RefreshToken` where `revokeReason='reuse'` (`userId` / `familyId` / `jti` / `ip` / `userAgent` / `revokedAt`, ordered by `revokedAt desc`)

#### POST `/admin/sessions` — Overview of all active user sessions system-wide

- **Request body**: `{ skip?: number, take?: number, userId?: number, ip?: string }` (`ip` fuzzy match)
- **Response `data`**: `{ list, total }`, each containing `userId` / `jti` / `device` / `userAgent` / `ip` / `createdAt` / `expiresAt` / `user{id,account}` (only non-revoked and unexpired)

> This overview queries only the user session table `RefreshToken`; the admin's own active sessions live in a separate `AdminRefreshToken` table and are not listed here.

#### POST `/admin/sessions/purge` — One-click purge of all active sessions

- **Behavior**: finds all users that still have active sessions and calls `invalidateAllSessions(userId, 'admin_purge')` for each (forces re-login for all, access invalidated immediately)
- **Response `data`**: `{ purgedUsers: number }`

---

## SSE Events

> Endpoint: [src/gateway/events.controller.ts](../../src/gateway/events.controller.ts) + [src/gateway/sse.service.ts](../../src/gateway/sse.service.ts) · `GET /api/v1/events` (`text/event-stream`, on the same port 3000 as HTTP)

### Connection and Authentication

```
// The browser's native EventSource does not support custom headers, so the frontend uses @microsoft/fetch-event-source
fetchEventSource(`${apiPrefix}/events`, { headers: { Authorization: 'Bearer <access_token>' } })
```

- The access_token is passed in via the `Authorization: Bearer` header (**not in the URL**). Authentication reuses the same `JwtAuthGuard` as HTTP (signature verification + expiry + jti blacklist + `tokenVersion`).
- Authentication failure: `JwtAuthGuard` returns HTTP 401 directly (**no `AUTH` frame**); the frontend `onopen` receives subsequent retries + reopens.
- Logout-all / password change / admin kick-offline trigger the `auth.sessions-invalidated` event → `SseService` pushes `FORCE_LOGOUT` and then disconnects all of that user's connections.
- Heartbeat: the server sends a `: ping` comment frame every 25s; the frontend reconnects with exponential backoff (full jitter, capped at 30s) on disconnect, and after reconnecting pulls missed messages by the `newestMsgId` cursor.

### Message Format (SSE text frames)

```
event: <EVENT_NAME>
id: <msgId>          # only NEW_MESSAGE carries this
data: <json>         # JSON string
```

> Authentication is not in the frame (handled by HTTP 401), so there is no WS-era `AUTH` frame. `: connected` / `: ping` are comment lines and are not counted as events.

### Event List (backend → frontend)

| Event | Trigger | `data` | Client handling |
| --- | --- | --- | --- |
| `NEW_MESSAGE` | Peer/group member sent a new message | Full message body `{ threadId, id, content, contentType, createdAt, ... }` (already serialized) | Render directly (no second fetch needed) |
| `FORCE_LOGOUT` | Logout-all / password change / admin kick-offline | `{ event:'FORCE_LOGOUT', status:0, message:<reason> }` | Disconnect + force re-login |

> Ordering and completeness: while a single connection is alive, strict ordering and completeness are guaranteed by TCP; messages during disconnect are caught up via cursor pull after reconnecting.

### Client → Server

SSE is unidirectional; **clients do not send business messages over SSE**. All writes (sending messages, invites, future typing) go through HTTP `POST`.
