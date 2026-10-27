# API Reference

The SOMS backend listens on `http://localhost:3000` with the global prefix `/api/v1`. Unless otherwise noted, **all endpoints are `POST`** (including query-type endpoints), with JSON request bodies and a unified response format. File upload endpoints use `multipart/form-data`.

## Table of Contents

- [Common Conventions](#common-conventions)
- [Authentication API](#authentication-api)
- [User API](#user-api)
- [Relationship API](#relationship-api)
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

- The token is returned once at login (`{ session_token }`) and stored sha256-hashed in the `SessionToken` table.
- **Browser / desktop (web shell)**: the server sets it as an **httpOnly cookie** (auto-attached same-origin; JS never reads it). A non-httpOnly `logged_in` presence cookie lets the SPA observe login state.
- **Native (`app`)**: the client sends `Authorization: Bearer <session_token>` (stored in OS secure storage; under Tauri the Rust transport injects it).
- Every route is authenticated by the global `SessionAuthGuard` (`APP_GUARD`) unless it opts out with `@Public()`. S2S routes opt out of user-session authentication but still enforce their own federation signature and authorization context; they are not anonymous business APIs.
- There is **no token-renewal endpoint**. All clients use a sliding inactivity deadline (30 days by default); client kind does not grant a permanent session. A valid token needs no rotation; a revoked/expired token yields `10007` (`SESSION_REVOKED`) and the client re-logs in. On 401 the web client navigates to login (`redoLoginAuth`).
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

> Business results normally use HTTP 200 + `code`. Array-valued DTO validation failures are folded into 200 + `10000`; explicit `BusinessException` statuses and other HTTP exceptions retain their selected status (including 400, 401, 403, 409, 429, and 5xx). S2S has a separate status/code registry. `Date` → ms timestamp; BigInt → string (global `SerializeInterceptor`).

### Business Error Codes

Segmented by domain prefix. Full definitions: [src/common/business-code.ts](../../src/common/business-code.ts) (`BusinessCode` enum).

| Segment | Domain          | Primary codes                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`     | Success         |                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `10xxx` | General         | `10000` validation · `10001` not found · `10002` already exists · `10003` unauthenticated · `10004` forbidden · `10005` rate-limited/IP-banned · `10007` session revoked · `10008` quota exceeded · `10009` invalid credentials · `10010` registration disabled · `10011` login method disabled · `10012-10016` OTP/QR invalid/expired/consumed · `10017` password not set · `10018` must change password · `10019-10025` admin 2FA / WebAuthn · `10999` server error |
| `20xxx` | Friend · Invite | `20001` friend self · `20002` friend not found · `20004` invalid target (e.g. a group account) · `20010` invite not found · `20011` invite expired · `20012` invite not yours · `20013` invite already handled                                                                                                                                                                                                                                                        |
| `30xxx` | Message         | `30001` empty content · `30002` thread not approved · `30003` thread not found                                                                                                                                                                                                                                                                                                                                                                                        |
| `40xxx` | Group           | `40003` invalid invite token · `40004` owner must transfer · `40005` role forbidden · `40006` target not a member                                                                                                                                                                                                                                                                                                                                                     |
| `50xxx` | Federation      | `50011` peer daily-quota exceeded (HTTP 429)                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `70xxx` | Call            | `70001` not allowed (not friends) · `70002` call not found · `70003` not a participant · `70004` busy · `70005` invalid state transition                                                                                                                                                                                                                                                                                                                              |

---

## Authentication API

> Controllers: [src/controller/auth.controller.ts](../../src/controller/auth.controller.ts) · [auth-otp.controller.ts](../../src/controller/auth-otp.controller.ts) · [auth-qr.controller.ts](../../src/controller/auth-qr.controller.ts) · Service: [src/auth/auth.service.ts](../../src/auth/auth.service.ts)

### POST `/auth/login` — Password login `@Public`

- **Body**: `{ account: string, password: string, client?: 'app'|'web'|'desktop', device?: string }`.
  `client` defaults to `web` and is informational. All clients use the account inactivity policy, 30 days by default. `trusted` and `persistent` are not login inputs. Browser cookies are one-year credential carriers; server-side expiry remains authoritative.
- **Behavior**: `LocalStrategy` verifies the password (argon2); on success issues a `SessionToken`, sets the session cookies, and returns `{ session_token, mustChangePassword? }`. Native clients use the returned token as `Authorization: Bearer <session_token>`; browser clients use the httpOnly cookie. Failures are counted by the shared `BruteForceService` (ip + user dims, sliding window + graduated ban ladder).
- **Errors**: `10009` invalid credentials · `10005` banned (`data.bannedUntil`) · `10017` password not set (OTP/QR-only account) · `10018` must change password (admin-generated initial password).

### POST `/auth/otp/login` — OTP login `@Public`

- **Body**: `{ account: string, code: string, client?: 'app'|'web'|'desktop', device?: string }` — the admin-issued 6-digit one-time login code. `client` defaults to `app`.
- **Behavior**: verifies the `LoginCode` (argon2, single-use through a conditional database update), sets the session cookies, and returns `{ session_token, mustChangePassword? }`.
- **Errors**: `10012` OTP invalid · `10013` expired · `10014` consumed.

### POST `/auth/qr/{create,poll,scan,confirm}` — QR login

- `create` and `poll` are public because the desktop is not authenticated yet. `scan` and `confirm`
  require an already authenticated device. The desktop calls `create` to render a QR; the phone
  `scan`s and `confirm`s it; the desktop `poll`s until it receives `{ status, session_token }`.
  Errors: `10015` QR invalid · `10016` expired.

### POST `/auth/logout` — Logout (current session) `@Public`

- Revokes the current `SessionToken` (`revokeReason='logout'`) and clears the session cookies.

### POST `/auth/logout-all` — Logout all devices

- `invalidateAllSessions` — revokes **all** of the user's `SessionToken`s and force-disconnects their SSE connections (`FORCE_LOGOUT`).

### POST `/auth/change-password` · `POST /auth/set-password`

- `change-password`: `{ oldPassword, newPassword }` — verify old, rotate, revoke **every** session (the client re-logs in). `10000` message=`old password wrong` on mismatch.
- `set-password`: forced first-time set after an admin-generated initial password (clears `mustChangePassword`); the caller is already session-authenticated.

### POST `/auth/sessions` · `POST /auth/revoke-session`

- `sessions`: list the user's active `SessionToken`s (device / userAgent / ip / createdAt / expiresAt / lastSeenAt).
- `revoke-session`: `{ id }` revoke one of the user's sessions by its device-list row id.

### GET `/auth/session-settings` · PUT `/auth/session-settings`

- `GET`: returns the current user's automatic inactive-session termination policy.
- `PUT`: `{ days }` updates that policy for the current user. This affects automatic termination of
  old inactive sessions; it does not revoke the current session immediately.

> Full session-hardening rationale (opaque token, sliding inactivity lifetime, revocation reasons, SSE coordination) is in [architecture.md → Authentication](../overview/architecture.md#authentication-mechanism).

---

## User API

> Controller: [src/controller/user.controller.ts](../../src/controller/user.controller.ts)

### POST `/user/register` `@Public`

- **Body**: `{ account, password }`. User accounts are 1–30 ASCII characters,
  start with an alphanumeric character, may then contain alphanumerics, `.`, `_`, or `-`,
  and are normalized to lowercase.
- **Behavior**: creates a local `Account` at default profile revision 0 without a `Profile` row. The first profile edit publishes revision 1. Foreign identities do not get local login rows.
- **Errors**: `10002` already exists · `10010` registration disabled (admin-provisioned accounts only — the common mode).

### POST `/user/my-profile` · `/user/update-profile`

- `my-profile`: returns only account facts: `{ id, account, namespaceId, isGroup, isDeleted, profileRev }`.
  It queries `Account` only; it does not join or resolve `Profile`, and does not return display fields or credentials.
  `profileRev` is `Account.defaultProfileRev`. At revision 0, clients use the account name for local display
  and initials without making a profile-resolution request. Positive revisions use the profile resolver;
  revision 0 remains invalid input to that resolver.
- `update-profile`: `{ name, bio, avatarBase64? }` (handle cannot change; creates a complete immutable profile revision and advances `Account.defaultProfileRev`). `name` and `bio` are required.
  Set `avatarBase64` to a validated image payload to replace the avatar, or `null` to remove it.
  Avatar bytes are validated, kept byte-for-byte, and returned through the profile response; there is
  no separate `/user/update-avatar` endpoint.

### GET `/user/state-feed` — Client state feed

- **Query**: `after`, optional `through`, `take`, and `mode=full|delta`. Returns a bounded page of
  complete incoming-request head snapshots after its independent durable state-feed cursor; each
  row body is `{ requestEndId, requestReadId }` with no event-type discriminator. Conversation
  snapshots, content heads, read/unread state, and previews come from `POST /thread-feed`, not this
  endpoint. Relationship and pair state reaches clients through the thread-feed snapshot; pending
  relationships do not create thread-list entries. Rows are permanent transport history: clients
  fold the range into their current head and may forget coordinates older than their full-sync
  boundary. Filtered ranges still advance the response cursor.
  The response carries the current feed end and the next cursor for deterministic catch-up, plus the
  `profileNamespaceChangeEndId` hint.
- The client state feed no longer publishes `THREAD_STATE` or per-relationship entries.
- The default profile reference remains fixed until the relationship is established again. Revocation
  retains the previous reference; ordinary profile changes do not replace it.
- `GET /user/group-meta` serves a visible group's full or delta roster feed by `threadId` or account.
  `MEMBER_UPSERT` and `MEMBER_DEPART` carry `body: { account, namespaceId, role, profileRev }`, with no top-level member account or domain. `namespaceId` is the publisher-scoped subject coordinate; clients resolve profile content separately.
  `GROUP_PROFILE` carries `body: { account, namespaceId, profileRev }`. These are current client API shapes, not a claim that the S2S implementation matches the independent draft.

### POST `/user/profile-resolution` — Resolve a profile

The request is a projection-free exact profile demand:

- `ACCOUNT_PROFILE`: `{ publisherNamespaceId, lookup: 'ACCOUNT_PROFILE', target: { profileNamespaceId, account, rev } }`
- `GROUP_MEMBER_PROFILE`: `{ publisherNamespaceId, lookup: 'GROUP_MEMBER_PROFILE', target: { profileNamespaceId, account, rev }, groupAccount }`

The request carries no `threadId`, `messageSeq`, Meta feed coordinate, selector, or separate evidence
object. Clients use the exact identity and revision already present in visible thread, relationship,
or group-meta records. Exact cached snapshots are returned without local per-caller disclosure authorization; this is intentional policy, including after relationship revocation or for an unrelated authenticated caller. Authorization gates new fetch work on a cache miss, not reads of existing cached snapshots. The authenticated `{ demand, evidence: null }` wrapper performs cache-only lookup, returns `NOT_FOUND` for an absent exact snapshot, and never initiates a fetch. This does not change S2S disclosure authorization or the exact publisher/namespace/account/revision cache key. `READY.profile` includes both `publisherNamespaceId`
and `profileNamespaceId`; `PENDING.key` is the expected `{ publisherNamespaceId, profileNamespaceId,
account, rev }` tuple. Domain is resolved through the publisher-scoped namespace binding and is not a profile-demand field. Completion is announced by the authenticated event stream with the same
tuple and clients then reread their local profile store.
These are client/backend implementation field names. For federation profile
requests, `publisherNamespaceId` selects the locally recognized peer and is not
sent as a profile field; `target.profileNamespaceId` becomes the S2S path's
`:namespaceId`. Account Profile and Group Member Profile map directly to their corresponding S2S operations. Exact relationship-intent profile disclosures are authorized through Account Profile with the requested exact revision.

### POST `/user/resolve`

- Local exact account lookup. A foreign domain is rejected; federated exact lookup must use the
  temporary stream below. (`10001` not found.)

### GET `/user/resolve-federated-stream` — Temporary federated exact lookup

- **Query**: `{ account, domain }`; authenticated temporary SSE, with a 30-second server-side bound.
- If either local recognition direction is missing, the lookup explicitly starts recognition. It then
  polls signed Health with per-domain request coalescing. `available` or `degraded` confirms the peer's
  recognition, while `unavailable` does not. The profile is retrieved after the local readiness gate passes.
- Emits one terminal `resolved` or `failed` event and closes. Closing the client connection cancels client
  interest; the server-to-peer request keeps its normal bounded timeout.
- The result contains a transient untrusted display card (`user`) addressed by `{ account, namespaceId }`, with no domain identity field. The card is not persisted and creates no foreign account stub; clients may close it and start another lookup at any time. Clients determine relationship
  state from their synchronized local thread and request projections.

### Namespace bindings

- `POST /profile-namespaces/resolve` accepts exactly `{ publisherNamespaceId, profileNamespaceId }` and returns a `READY` binding or `PENDING` fetch admission.
- `GET /user/profile-namespace-feed` exposes client namespace invalidations; `PROFILE_NAMESPACE_UPDATED` is its live wake hint.
- There is no `/message/quote-resolution` endpoint. Quote navigation uses the message-query anchor coordinates and the ordinary message history synchronization path.

---

## Relationship API

> Controller: [src/controller/relationship.controller.ts](../../src/controller/relationship.controller.ts) · Service: [src/relationship/relationship.service.ts](../../src/relationship/relationship.service.ts)

Friend and group requests use the same directed facts. `RelationshipIntent(A,B)` and
`RelationshipIntent(B,A)` are independent rows with independent notes. For a group relationship,
one account is the group account and the other is the member account; `authorUserId` identifies which
side authored the intent. Every observed request round is also stored as a permanent
server-owned `RelationshipRequest` record covering friend requests, group applications, and group
invitations; lists and decisions address that record by its decimal-string `requestId`. The former
polymorphic `Invite` table has been removed. Intent identity itself (the four-column direction
key) is not part of the API contract. See the
[relationship intent state machine](../overview/relationship-intent-state-machine.md) for the
complete transition, pair-folding, and projection-side-effect rules.

### POST `/relationship/request` — Request a user or group relationship

- **Body**: `{ account, namespaceId, note?: string(≤255), snapshot: { displayName, avatar } }`. Namespace `0` selects a local account; a positive server-local identity namespace comes from the preceding federated resolve. The snapshot is the send-time presentation of the receiver for the author's outgoing card; `avatar` is an explicit image reference or `null`. `domain` and numeric user IDs are not mutation target fields.
- **Response data**: user intents return `{ status: "OK", threadId? }`; group-member intents return
  `{ status: "APPLIED" }` or an idempotent `{ status: "NO_OP", reason }`. Expected refusal is an
  HTTP-200 business envelope whose data is `{ status: "REJECTED", reason }`.
- Execution opens or refreshes the caller's directed request round. A retry against the same live
  round keeps its ID, evidence, and timestamps; a resend after expiry or a terminal conclusion
  opens a new round with a new ID while the old round keeps its status and evidence. A live
  reverse direction — their pending request, or their ACCEPTED that an own earlier revoke has not
  yet reached — collapses into acceptance and re-establishes the pair synchronously. `20001` friending self · `10001` target not found.
- A federated request publishes only `RELATIONSHIP_INTENT`, including the author's referenced
  profile namespace and `profileRev`. The receiver resolves that exact reference independently through the global profile
  resolver; there is no separate `PROFILE` State Feed event. An immutable `Profile` may be cached by that resolution without creating a foreign login/account row or changing relationship authorization.
- The federated request transaction performs no peer discovery, recognition, or inline network
  operation. The preceding exact-address resolve must already have established an active peer namespace.
  If it has not, the command returns a business rejection and creates no relationship request or State
  Feed item. Peer delivery is awakened only after commit.
- The round ID is exposed to the author through the SENT list and drives later decisions. A group
  account is accepted only for a federated group-join
  request; a local group relationship still requires an existing invitation.

### POST `/relationship/revoke` — End an established P2P relationship

- **Body**: `{ threadId }`, a positive P2P thread identifier. The former address
  payload is rejected; there is no compatibility route.
- Ends only an active P2P relationship belonging to the caller, symmetric to
  group leave. Conversation history and concluded request records are retained.
- The domain revalidates the active pair, thread and captured authorization epoch
  under business locks. It must not redirect a stale revocation to a pending round.
- Pending requests use `requests/reject` or `requests/withdraw` with an exact
  `requestId`. Active group membership still uses `/group/leave`.
- **Response data** follows the synchronous business-result contract above.

### POST `/relationship/accept` — Accept an incoming friend request

- **Body**: `{ requestId }`, the exact round ID observed on the RECEIVED list. The decision is
  admitted only while that round is still the open round associated with the intent; a replaced or
  concluded round returns `STALE_REQUEST`, an expired one `EXPIRED`. There is no address fallback.
- Acceptance authors the caller's reverse direction, concludes the round as ACCEPTED, and
  activates the pair synchronously. **Response data**: `{ status: "OK", threadId }` with the
  active P2P thread.
- A received federated request is projected into a local round on the receiving server using the
  wire's own validity window; the receiver decides by that local round ID. Group invitations are
  accepted through `POST /group/join-request`.

Request rejection and withdrawal use `/relationship/requests/reject` and
`/relationship/requests/withdraw` with `{ requestId }`. Established friendship
removal uses `/relationship/revoke` with `{ threadId }`, never the counterparty
Address. Each transaction validates its distinct operation under business locks. A USER→GROUP federated join
application likewise uses `/relationship/request`. GROUP→USER invitation administration remains
under `/group/*` because the group, rather than the current user, authors that direction.

- Federation convergence is asynchronous through the state feed; there are no S2S invite command
  endpoints.
- Every pending friend/group request has an absolute expiry of at most seven days. Expired requests
  are ineffective even if an old feed projection remains. REVOKED has no expiry and is retained
  best-effort.

### POST `/relationship/requests` — Online request list

- **Body**: `{ bucket: "RECEIVED"|"SENT", before?, take? }`; `before` is an exclusive round-ID
  decimal string, `take` is 1..50 (default 20). Newest round IDs first.
- **Response data**: `{ items, hasMore, before, incomingHead }`. Items are closed records keyed by
  round ID: INCOMING carries the exact author profile reference, OUTGOING the send-time snapshot.
  Only rounds created within the last seven days are visible; older rounds stay stored but never
  escape the window. Terminal status changes do not advance `incomingHead`.

### POST `/relationship/requests/read`

- **Body**: `{ requestReadId }`, a round-ID decimal string bounded by the account's current
  `requestEndId`; the read advances monotonically and a duplicate or lower value is a no-op.
- **Response data**: the complete `incomingHead` `{ requestEndId, requestReadId }`, synchronized
  through ClientStateFeed.

---

## Message API

> Controller: [src/controller/message.controller.ts](../../src/controller/message.controller.ts) · DTO: [src/dto/message.dto.ts](../../src/dto/message.dto.ts)

### POST `/send-message` — Send message

- **Body**: `{ threadId: number, content: string, contentType?: 'PURE_TEXT'|'LINK', clientMessageId?: UUID }`. Media messages use `/send-media` followed by the matching `/upload*` endpoint.
- **Behavior**: `ThreadAccessGuard` checks membership; allocates a per-thread `seq` atomically from `curSeq`; `MessageFanoutService` publishes each recipient's compacted `THREAD_CONTENT_HEAD`, wakes live clients through `STATE_FEED_UPDATED`, and notifies offline recipients through Push. `clientMessageId` is the send-idempotency key (a retry returns the original message).
- **Replies**: PURE_TEXT content is `{ "text": "...", "quote": { "seq": n } }`. `n` must be a positive sequence identifying a visible message in the same local thread when sending; zero is invalid. Replies received through federation retain their positive source coordinate and digest even if the target body has not arrived. Ordinary text omits `quote`. Internal federation namespaces are not client navigation coordinates.
- **Errors**: `30001` empty · `30002` not approved · `30003` thread not found.

### POST `/send-contact-card` — Share a contact snapshot

- **Body**: `{ threadId, target: { account, namespaceId, profileRev }, clientMessageId }`. The same three-part target identifies a user or group; no numeric target ID is accepted.
- **Behavior**: the server checks that the target is a visible group, an available local user, or an active federated friend, then snapshots the exact stored profile version. If that version is unavailable, the card uses `account` as its display name, an empty bio, and no avatar. Available avatar bytes are copied into message CAS storage. The resulting `CONTACT_CARD` message is immutable.

### POST `/send-media` — Send media (staged)

- **Body**: `{ threadId, contentType: 'IMAGE'|'FILE'|'VIDEO'|'AUDIO', clientMessageId, ...display meta }`. Stages a `PendingMedia` row; the bytes land via `/upload` and are promoted to a `Message` once confirmed. (`/query-media-stages`, `/media-status`, `/relocalize-media` support the staging lifecycle.)

### POST `/link-preview/generations` · GET `/link-preview/generations/:generationId`

- `POST`: `{ url, text?, generationId? }` starts a short-lived, rate-limited OpenGraph/link-card
  generation and returns its generation id and status. The server fetches the URL asynchronously.
- `GET`: polls the result for the authenticated owner. Generation records are in-memory and expire;
  they are not a durable message or media resource.

### POST `/send-forward` — Send an immutable forwarded-message bundle

- **Body**: `{ threadId, sourceMessages: [{ threadId, seq }], mode: 'DIRECT'|'HISTORY', clientMessageId, quoteTargetSeq? }` (1–100 source messages).
- **DIRECT**: requires exactly one visible source and re-sends it as the current caller, removing the source's outer reply context. For a `FORWARD` card, it preserves the complete bound bundle, its historical display snapshots and assets, and its existing depth; it neither flattens the card into summary text nor adds a wrapper. The new message has its own bundle binding and supplies destination readers' authorization.
- **HISTORY**: the server, never the client, snapshots sender display data and content into the `ForwardBundle.messages` JSONB array. `ForwardBundleDependency` indexes directly nested bundles for closure traversal. Attachment and avatar bytes remain deduplicated CAS objects referenced by `ForwardBundleAsset`. The resulting `Message` has `contentType: 'FORWARD'`; its small JSON content contains `bundleId`, up to two 100-grapheme summary lines and counts.
- **Depth**: a leaf bundle is depth 1 and a HISTORY parent is `1 + max(child.depth)`. Maximum depth is 3. Wrapping an existing depth-3 card in HISTORY returns `30004`; DIRECT can retain that card without increasing depth. The server validates these limits regardless of frontend checks.
- **Shared children and counts**: multiple inner messages may reference the same child bundle. The closure carries one body per digest, and stored dependency edges are deduplicated per parent. Every reference contributes to the expanded message count, including descendants: two cards pointing to a 300-message child count as 602. The server's maximum is 500 expanded messages, not 500 unique stored messages. Assets remain deduplicated, and sharing grants no additional resource access.
- **History replies**: bundle text contains only `text`; `quoteTargetId` on the entry refers to a message ID in that same bundle array. Selected reply targets are remapped to those IDs; absent or unselected targets are emitted as `0`. Imported positive references without a target entry are also displayed as unavailable. DIRECT mode strips reply context.
- **Snapshot presentation**: inner bundle messages carry only frozen `profile.displayName` and optional `profile.avatarDigest`, not an author account, domain, or public key. Equal names/avatars do not establish a shared author; each detail row is presented independently. CONTACT_CARD content retains its own target address and public key. Browser, desktop, and Android share this detail renderer; native HTTP and media access still use Rust transport.
- **Identity**: the card's `bundleId` and the read route use the stable 64-character SHA-256 content digest. Local bigint record IDs and private nested-storage references never appear in client cards or public closures, and are not accepted as aliases by the read route.
- **Read**: `GET /forward-bundles/:bundleId` returns the visible root and its complete child closure after checking that the caller participates in a thread containing the root card.

### POST `/query-messages` — Paginated history

- **Messages**: a union of ordinary messages and query-only tombs. A tomb has
  `contentType: 'TOMB'`, `isDeleted: true`, and `deletionType: 'USER_RETRACTION' | 'MODERATION_REMOVAL'`,
  retaining `threadId`, `seq`, `creator`, `profileRev`, `createdAt`, and `updatedAt`.
  It contains no original body, quote, media metadata, or internal ID. Tombs occupy
  their original sequence slot and count toward page size in both directions.
  `TOMB` is not accepted as a sendable content type.
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

Successful message pages additionally include `gaps` and nullable `resolvedAnchorSeq`. `anchorSeq` selects a local message anchor; `anchorNamespaceId` plus `anchorOriginSeq` selects a source coordinate. Anchor and ordinary direction cursors cannot be combined. Gaps describe recoverable missing intervals, not fabricated messages; see [client history synchronization](../design/client-message-history-sync.md) for the bounded range-walking contract.

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

### POST `/thread/{mark-read, set-muted, set-pinned, set-alias}`

- Per-`AccountThreadState` mutations: read watermark advance, mute, pin, and per-thread alias. `search-messages` does in-chat search.

`mark-read` synchronously commits a viewport read mutation:

- **Body**: `{ threadId, localReadHwm, force?: boolean }`; position is a nonnegative int32.
- **Data**: `{ status: 'APPLIED', lastReadSeq: number }`; an unavailable account-thread
  relationship returns the normal business result `{ status: 'REJECTED', reason: 'THREAD_NOT_FOUND' }`.
- Ordinary requests preserve a monotonic cursor. `force: true` permits rollback;
  ordinary clients omit it.
- The HTTP business transaction atomically adjusts the exact persisted unread count and read position.
  No count cap applies; `999+` is a client presentation choice.
- After commit, the server publishes an SSE hint for clients to pull the thread feed.

### POST `/thread-feed`

- **Body**: `{ after: number, through?: number, take?: number, previewCount?: number }`; feed cursors are
  nonnegative int32, take defaults to 100 and is limited to 1..200.
- **Data**: `{ threadFeedEndId, through, scannedThrough, hasMore, items }`.
- Each item includes `threadId`, `threadFeedId`, `type`, `publisherNamespaceId`,
  required nullable `selfMentionNamespaceId`,
  `conversationState`, `blocked`, nullable `role`, `profileAccount`, `profileRev`,
  `messageEndSeq`, `tombstoneEndSeq`, nullable decimal-string `groupMetaFeedEndId`,
  `joinRequestEndFeedId`, `joinRequestReadFeedId`, `groupInviteEndFeedId`,
  `lastReadSeq`, `announcementReadFeedId`, `unreadCount`, nullable `lastMentionSeq`, and nullable `alias`.
  There is no nested `profile` object or wire `threadProfileRev` field.
  `lastMentionSeq` is nullable; clients compare it with their local read position.
  `selfMentionNamespaceId` places the viewing account's home in the group origin's
  namespace space: `0` for a local group, the origin's peer-assigned positive
  namespace for a remote group, or `null` for P2P or an unavailable binding.
  User mentions match this namespace and the viewer account exactly; unknown
  mappings never fall back to account-only matching. Clients require the field
  in snapshots and store it in their typed thread record; no legacy missing-field
  or cache migration compatibility is provided. Cache schema versions remain `1`.
  `joinRequestReadFeedId` is `-1` for non-managers; otherwise a join-request
  notification is unread when it is smaller than `joinRequestEndFeedId`.
- `previewCount` defaults to zero and cannot exceed three. When requested,
  `previews` is required (possibly empty). Previews include sequence, sender identity
  and profile revision, timestamp, and live/retracted/removed status; deleted entries
  contain no original message text. Clients persist only the greatest-sequence preview.
- Initial consumption uses `after: 0`; omitted through captures the current head.
  Subsequent pages reuse through. Persist items and scannedThrough atomically.
- Rows are compacted by account/thread and ordered by threadFeedId. An empty
  final page still advances scannedThrough to through. Drain a newer head next.
- An invalid/ahead range returns `THREAD_FEED_CURSOR_INVALID` (30007).
- HELLO carries `threadFeedEndId`; `THREAD_FEED_UPDATED` carries
  `{ threadFeedEndId }` as a wake hint. Content and unread state share each snapshot.
- Backend and clients require coordinated cutover; there are no old delta aliases.

See [unified thread feed](../design/thread-feed.md) for transaction,
task coalescing, and optimistic client correction semantics.

---

## Group API

> Controller: [src/controller/group.controller.ts](../../src/controller/group.controller.ts) · DTO: [src/dto/group.dto.ts](../../src/dto/group.dto.ts)

### POST `/group/create`

- **Body**: `{ name, avatar?, description? }`. Creates the local `GroupAccount`, `MessageThread(GROUP)`, selected immutable profile, and canonical Group Meta state. Invitations use the separate invite operation; no `inviteUserIds` input is accepted. Returns `{ threadId }`.

### POST `/group/invite`

- **Body**: `{ groupId, users: [{ account, namespaceId, snapshot: { displayName, avatar } }] }` — author one GROUP invitation per valid namespace-bound user. The caller must be an active OWNER or ADMIN; friendship with the invitee is not required. The server resolves each target to its authoritative identity without selecting an identity copied from another peer's group. Namespace `0` selects local users. Duplicate normalized targets are coalesced; the synchronous response reports `invited` and `skipped` targets with rejection details.
- An unanswered invitation does not activate membership. The invitee must accept, unless they already have a live join application that the invitation accepts. Active members and duplicate unanswered invitations are rejected.

### Group request rounds

- `POST /group/join-requests` and `POST /group/invitations` use the shared newest-first request-page
  contract: `{ groupId, before?, take? }`. The caller must be an active OWNER or ADMIN; rows are
  shared round records keyed by exact request ID, plus the group-scoped
  `joinRequestEndFeedId`/`joinRequestReadFeedId` manager coordinates.
- `POST /group/join-request/accept` and `POST /group/join-request/reject` decide a member-authored
  application by `{ groupId, requestId }`.
- `POST /group/invitation/revoke` cancels a still-live group-authored invitation by
  `{ groupId, requestId }`.
- `POST /group/join-request` accepts the caller's received invitation round by `{ requestId }`
  alone and returns `{ status: "OK", threadId }` for the joined group thread.
- `POST /group/invitation/decline` declines the caller's received invitation round by
  `{ requestId }` alone; `POST /group/join-request/withdraw` withdraws the caller's own pending
  application round by `{ requestId }` alone. Both return `{ status: "OK", threadId }`.
- Every decision settles the exact round through the authored membership state machines (pair
  activation, roster/meta facts, system messages, thread fan-out) with an exact-round gate under
  the business locks, and returns `OK`, `STALE_REQUEST`/`EXPIRED` for closed rounds, or an
  HTTP-200 business rejection.
- These lists read the permanent server-owned round records written in the owning intent's
  transaction. They are not membership authority.

### POST `/group/{leave, kick, transfer, set-role, update}`

- `leave` (`40004` owner must transfer first) · `kick` (`40005` forbidden,
  `40006` target not a member) · `transfer` (ownership) · `set-role`
  (ADMIN/MEMBER) execute synchronously and return business results. `update`
  (name/avatar/bio) is also synchronous.

### POST `/group/announcement/set` · `/group/announcement/read`

- `announcement/set`: OWNER or ADMIN only. Body `{ groupId, text }`, where
  `text` is plain text with 1–4096 Unicode code points; use `null` to clear the
  current announcement. The origin allocates a new Group Meta coordinate for
  every effective publish, edit, or clear and returns `{ feedId }`.
- `announcement/read`: any active member. Body
  `{ groupId, announcementFeedId }`. The coordinate must be a known current
  group announcement coordinate. The acknowledgement is idempotent and
  monotone, advances only the announcement watermark, and does not mark chat
  messages read. It returns `{ announcementReadFeedId }`.
- Announcement text is rendered as plain text. The current projection is
  delivered through Group Meta; it is not a message and does not create a
  timeline or unread-message item.

### POST `/group/dissolve`

- **Body**: `{ groupId }`. Owner-only. Conversation history is retained.
- Returns `{ taskId: string, status: "PENDING" }` after durable acceptance.
  The parent task commits the permanent dissolution marker and durably
  checkpoints one member-revoke child task per active roster member. It does
  not wait for those children to execute.

---

## Calls API

> Controller: [src/controller/calls.controller.ts](../../src/controller/calls.controller.ts) · Service: [src/calls/calls.service.ts](../../src/calls/calls.service.ts)

1:1 audio/video calls. The server is a **signaling coordinator + lifecycle owner only** — it never touches media. On a terminal state `CallsService` commits a local `SYSTEM / CALL_ENDED` notice on each participating server.

- `POST /calls/initiate` `{ callSid, threadId, callType }` → `{ callSid, threadId }` (`70001` not friends · `70004` busy).
- `POST /calls/{accept, ringing, connected, decline, cancel, end, signal}` drive the FSM (`70002` not found · `70003` not a participant · `70005` invalid transition).
- `POST /calls/upgrade-video` requests the one-way AUDIO-to-VIDEO upgrade for the existing call.
- `GET /calls/ice-servers` — TURN/STUN helper (TURN off by default; misconfig throws).
- `GET /calls/:callSid/signaling` — caller-side answer fetch.

See the [Android calls client contract](../platform/android/calls.md).

---

## Device & Notification API

> Controllers: [device.controller.ts](../../src/controller/device.controller.ts) · [notification.controller.ts](../../src/controller/notification.controller.ts)

- `POST /devices/register` — register a push subscription directly on the authenticated session. Required fields: `sessionId`, `pushSubscriptionRev` (integer, at least 1), `platform`, and `token` (FCM token for ANDROID, endpoint for WEB). WEB also requires `p256dh` and `auth`; `deviceId` is optional diagnostic metadata. The supplied session ID must match authentication. Logout/revocation clears the subscription atomically; there is no separate unregister endpoint.
- `POST /devices/push-probes`, `GET /devices/push-probes/:probeId`, and `POST /devices/push-probes/:probeId/ack` — run and observe a one-off Web Push or Android FCM delivery probe for the authenticated session. No token or target session is accepted in the request body; the server selects the session's stored subscription.
- `GET /notifications/vapid-key` (`@Public`) — Web Push VAPID public key.
- `GET /user/state-feed` — account and relationship metadata.
- `POST /thread-feed` — complete conversation snapshots, thread heads, read positions, unread counts and bounded previews.
  Clients reconcile local optimistic reads and compose notifications from this feed.
  Message notifications have no action buttons. Body taps open the thread; dismissal is local.

### Interactive push delivery test

Browser notification settings and Android push settings share a **Send test** control.
It sends a real `PUSH_HEALTH_PROBE` even when the current session has a live SSE connection.
The response envelope's `data` contains `probeId`, `stage`, `createdAt`, optional `acceptedAt`,
`receivedAt`, `latencyMs`, and `errorCode`. Stages are `provider_accepted`, `device_received`,
or `failed`; only an authenticated receipt from the same user and session confirms delivery.
Web receives and acknowledges the probe inside its Service Worker, then attempts to display
a dedicated test notification even with the page open. Android acknowledges from its native
FCM receiver, independently of the WebView, preserving its silent delivery diagnostic.
Receipt does not prove the operating system displayed a notification.

The UI polls only during this explicit test, waiting up to 15 seconds after provider acceptance.
A timeout can mean either failed delivery or a failed receipt request. There is a 30-second
per-session send cooldown; provider TTL is 30 seconds. Status and cooldown are process-local,
expire after 60 seconds, and do not survive a server restart; multi-instance deployments need
sticky routing or a shared probe store. Missing registrations and disabled transports are
reported as failures. Permanent provider failures use normal revision recovery; the user can
retry after recovery and cooldown. Leaving settings or changing sessions cancels UI polling.
This replaces the former Android-only FCM probe endpoints without compatibility aliases.

### Session push recovery

New sessions start at `pushSubscriptionRev: 1`; clients start with completed revision 0.
HELLO includes `sessionId` and `pushSubscriptionRev`. A confirmed permanent send failure
(Web Push 404/410 or FCM `registration-token-not-registered`) atomically increments the
revision and clears the session's token, platform, encryption keys, and registration time.
The update matches the exact session, token, and revision captured before sending, so a
late or duplicate failure cannot clear a replacement subscription.

Only connections belonging to the affected session receive:

```text
event: PUSH_SUBSCRIPTION_CHANGED
data: {"sessionId":42,"pushSubscriptionRev":2}
```

Disconnected clients recover the same revision through their next HELLO. Web and Android
share the registration coordinator: revision 1 reuses or creates a local subscription;
a later unprepared revision replaces it. Preparation is persisted separately from upload
completion, so a failed upload or page restart does not repeatedly replace the subscription.
Web uses `unsubscribe()`/`subscribe()`; Android uses Firebase `deleteToken()`/`getToken()`.
Platform token changes also trigger registration. There is no periodic registration or
subscription polling; failed operations have bounded retries and later HELLO retries.
Android merges push revision events into its native HELLO cache while the WebView is
suspended, so the shared coordinator sees the latest revision when the WebView resumes.

Registration returns `{ sessionId, pushSubscriptionRev, registered }` in the API envelope's
`data`. `registered: true` confirms the submitted revision without incrementing it. If the
revision is stale, `registered: false` returns the current revision and leaves the database
unchanged. Clients then reconcile that revision. Only successful registration advances the
client's completed revision. Denied browser permission never triggers an automatic prompt.

An installation token is unique across sessions. A newer login may take it over from an
older session; a delayed older login cannot take it back. Session push data replaces the
former separate registration table. Migration `0001_session_push` discards old registrations;
clients must use the new protocol and re-register through HELLO.

Admin push-list and test IDs now identify sessions. Explicit administrative token removal
clears the subscription without revoking the login or requesting immediate recovery; a later
client bootstrap can register again. Provider-reported expiry uses revision-based recovery.

---

## File / Media API

> Controller: [src/upload/upload.controller.ts](../../src/upload/upload.controller.ts) · Service: [src/upload/upload.service.ts](../../src/upload/upload.service.ts)

### POST `/upload` — Upload staged chat media

- **Body**: `multipart/form-data`, one or more `file` parts, plus the staged-send `x-client-message-id` and
  per-file metadata such as `w`, `h`, or `duration`. The staged `/send-media` intent determines which
  media families are accepted. Files are magic-byte validated; the multipart part cap is 100 MB.
- **Behavior**: writes bytes through the **content-addressed CAS pipeline** — `MediaAsset` uses sha256 of
  the raw bytes and stores exactly one extensionless blob at `data/cas/<dd>/<dd>/<digest>`. The upload
  also records progress for the staged message; when all expected parts arrive, the pending send is
  promoted to a `Message`.
- **Response `data`**: one file returns its result (`digest`, `url`, `size`, and detected metadata); multiple
  files return `{ items: [...] }`.

### POST `/upload/avatar` — Upload a group avatar

- **Body**: `multipart/form-data`, field `file`.
- Validates one image, including magic bytes, federation size limits, and maximum 512×512 dimensions,
  then stores the accepted bytes unchanged under the avatar resource path. This route is for group
  avatar mutations; user avatars are updated with `POST /user/update-profile` and `avatarBase64`.
- The returned avatar path does not receive chat-message CAS authorization, but `/uploads/*` still
  requires an authenticated user session through the `media_token` cookie or `Authorization: Bearer`.

### Resumable upload

- `POST /uploads/resumable/init` initializes or recovers a sequential upload session.
- `GET /uploads/resumable/:uploadId` returns the authoritative offset.
- `PUT /uploads/resumable/:uploadId` appends one ordered `application/octet-stream` chunk using
  `Content-Range`.
- `POST /uploads/resumable/:uploadId/complete` validates, publishes, and promotes the completed upload.
- All four endpoints require the authenticated user who owns the upload session. The resumable flow is
  an upload transport and does not replace `/send-media` or `/upload`'s staged-send contract.

### Authenticated upload resources

- `/uploads/*` is served by `@fastify/static` with the same opaque session authentication as the API:
  httpOnly `media_token` cookie for browser requests or `Authorization: Bearer` for native clients.
- Chat-media CAS objects additionally require per-object authorization for the referenced thread/message.
  Avatar resources do not require membership in a particular chat thread, but they are not anonymous
  public resources.

> When switching to object storage (S3/OSS/MinIO), only the write target + URL generation change; the API contract stays the same.

---

## Admin API

> Controllers under `src/admin/` · Service: [src/admin/admin-auth.service.ts](../../src/admin/admin-auth.service.ts)

Admin auth is a **separate opaque session** (`AdminSession`, own `adminSecret`, `AdminAuthGuard`) — physically isolated from user sessions, but an admin is a linked profile on a `User` row (`Admin.userId → User.id`). `/admin/login` verifies `User.hashPwd` then issues an admin session. The login and its 2FA/passkey challenge steps are pre-session; all other admin routes require the httpOnly admin cookie.

### Authentication

- `POST /admin/login` `{ account, password }` → either `{ authenticated: true }` (sets the admin cookie)
  or a 2FA challenge `{ twoFactorRequired, challengeToken, factors }`; updates
  `Admin.lastLoginAt/lastLoginIp` after successful authentication. `10009` invalid credentials / disabled.
- `POST /admin/login/verify` `{ challengeToken, code?, backupCode? }` completes TOTP/backup-code login
  and sets the admin cookie.
- `POST /admin/webauthn/login/begin` `{ challengeToken }` returns passkey assertion options for a
  challenge; `POST /admin/webauthn/login/finish` completes the assertion and sets the admin cookie.
- `POST /admin/logout` — revokes the admin session.
- `POST /admin/2fa/status` — current TOTP status and remaining backup-code count.
- `POST /admin/2fa/setup` · `/admin/2fa/setup/verify` — begin and confirm TOTP enrollment; the
  verification response returns backup codes once.
- `POST /admin/2fa/disable` — disable TOTP; requires the current password and a live TOTP or backup code.
- `POST /admin/2fa/backup/regenerate` — replace backup codes; requires a live TOTP or backup code.
- `POST /admin/webauthn/status` — current passkey status.
- `POST /admin/webauthn/registration/begin` · `/admin/webauthn/registration/finish` — enroll a passkey.
- `POST /admin/webauthn/credentials` — list saved passkeys.
- `POST /admin/webauthn/credentials/:id/rename` · `/admin/webauthn/credentials/:id/delete` — manage
  saved passkeys. All self-service 2FA and passkey-management routes require the admin session.

### Management

- `POST /admin/users` `{ skip?, take?, search? }` → `{ list, total }`. Rows include
  `adminId`, `adminRole`, `adminEnabled`, and `adminTwoFactorEnabled`; ordinary users
  have null administrator fields. `POST /admin/users/:id/detail` also exposes
  `adminRole`, `adminEnabled`, `adminTwoFactorEnabled` (TOTP), and `adminLastLoginAt`.
  A null last-login timestamp means no recorded console sign-in; no credential secrets are returned.
- `POST /admin/users/:id/{disable,enable,force-logout,sessions,generate-initial-password}` — disable (soft-delete + invalidate sessions), enable, force logout, view sessions, or generate an initial password (password generation invalidates existing sessions). There is no `/reset-password` route.
- `POST /admin/threads/clear-history` `{ threadId, seq? }` — advances the thread-wide history boundary through `seq` (inclusive), or through the thread's current message sequence when omitted. Requires `ADMIN` or `SUPER_ADMIN` and is audited.
- `POST /admin/bans` lists current restrictions (`ip`, `user`, `otp`, `admin_pwd`,
  `admin_2fa`) with `key`, `value`, `until`, `remainingMs`, and `userId`. `userId` is
  an exact local-person match, or null for unknown accounts, groups, and IP restrictions.
- `POST /admin/bans/unban` `{ ip?, account? }` requires ADMIN or SUPER_ADMIN. An account
  release clears user-password, login-code, console-password, and console-second-factor
  restrictions together. IP release is independent. Neither enables a banned account;
  subsequent failures can trigger another restriction.
- `POST /admin/sessions` `{ skip?, take?, userId?, ip?, client? }` lists valid consumer
  sessions; `client` is `app`, `web`, or `desktop`. Rows expose `lastSeenAt`,
  `autoTerminateDays`, and `expiresAt`. Per-user lists and detail sessions expose the
  same lifetime fields. All clients use sliding inactivity expiry: 7, 30, 90, 180,
  or 365 days (default 30). Activity writes extend the deadline at most once per five
  minutes, on authenticated use, not on a periodic renewal timer. Changing the user's
  policy recalculates existing deadlines from each session's last recorded activity.
- `POST /admin/sessions/:id/revoke` requires ADMIN or SUPER_ADMIN and revokes only
  the selected consumer credential. `POST /admin/sessions/purge` requires SUPER_ADMIN
  and signs out all chat clients, including those of administrator accounts, regardless
  of list filters. Neither operation revokes console sessions.
- `POST /admin/admin-sessions` `{ skip?, take?, ip? }` lists console sessions with
  `isCurrent` and `canRevoke`. `POST /admin/admin-sessions/:id/revoke` lets every
  administrator end their own other sessions; only SUPER_ADMIN may end someone else's.
  The current session must use `/admin/logout`. Revocation is immediate and audited.
- `POST /admin/audit` — `@Audit`-tagged action log (`AdminActionLog`).
- `POST /admin/durable-tasks` — paginated durable-task execution history with status and search filters.
- `POST /admin/logs/output-level` → `{ level }`; `POST /admin/logs/output-level/set`
  `{ level }` changes the process-wide output threshold for console, files, and live logs.
  Supported levels: `trace`, `debug`, `info`, `warn`, `error`, `fatal`. The value stays in memory
  and resets to `warn` on every restart. The live stream returns all captured records;
  historical log search retains its independent minimum-level filter.
- Federation / quota admin: `AdminFederationController` (peer state and observations), `AdminQuotaController` (per-peer quota overrides). Diagnostics + log viewer: `AdminDiagnosticsController`, `LogViewerController` (`/admin/logs/*`).

Federation peer detail (`POST /api/v1/admin/federation/peers/:domain`) includes
`feedProgress.lastHandshakeAt` and `feedProgress.latestHealthCheck` from the
namespace's runtime state. The nullable Health observation includes
`namespaceId`, `domain`, `startedAt`, `completedAt`, `durationMs`, `source`
(`automatic` or `manual`), `status` (`available`, `degraded`, `unavailable`, or
null on request failure), and `error` (null on a valid response). Feed source
timestamps remain the last processed item times, not observation timestamps.

`POST /api/v1/admin/federation/health/probe` accepts `{ namespaceId }` for an
active, non-halted peer and requires ADMIN or SUPER_ADMIN. It shares the normal
Health execution path and returns the upgraded peer detail on success. Failed
checks retain their observation and return the normal API error; clients refresh
peer detail after either outcome. Opening detail never initiates a probe.
The web console and backend ship this contract together; the former standalone
probe-result shape is not supported.

## Client Diagnostics

- `POST /diagnostics/report` accepts an authenticated `multipart/form-data` diagnostic bundle and
  manifest for field support. The report is owned by the submitting user; only administrators can list,
  download, or delete reports.

## Client Bootstrap

- `GET /client/compat` returns the client API contract version, server software version, public
  registration/login policy, optional client origins and public Firebase configuration. It is public
  and rate-limited because an installed client requests it before a user session exists. App assets
  ship inside the installation package; the server does not publish OTA web bundles. The native
  compatibility predicate currently accepts valid responses unconditionally pending implementation
  of exact API version matching.

---

## SSE Events

> Endpoint: [src/gateway/events.controller.ts](../../src/gateway/events.controller.ts) + [src/gateway/sse.service.ts](../../src/gateway/sse.service.ts) · `GET /api/v1/events` (`text/event-stream`)

### Connection & HELLO

The browser opens the stream via a fetch-backed SSE client inside a Web Worker (the native EventSource API cannot set headers). The credential travels as the **httpOnly cookie** (browser) or `Authorization: Bearer` (native) — never in the URL. Authentication failure → HTTP 401 (no frame); the client reconnects.

On connect the server pushes a **`HELLO`** frame with `userId`, `sessionId`, `pushSubscriptionRev`, `stateFeedEndId`, `threadFeedEndId`, `profileRev`, and `activeCall`.
`stateFeedEndId` bounds relationship/request metadata catch-up. `threadFeedEndId` independently bounds conversation snapshots, settings/read state, unread counts, and content ends. Profile namespace and Group Meta invalidations use their own synchronization coordinates. The stream is push-only; it sends no idle heartbeat.

### Frame format

```
event: <EVENT_NAME>
id: <connection-local sequence>
data: <json>
```

### Event list (backend → frontend)

| Event                                       | Purpose                                                                                                       | Recovery source                              |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `HELLO`                                     | connection handshake and current high-water marks                                                             | sent on every connection                     |
| `PUSH_SUBSCRIPTION_CHANGED`                 | session-specific push recovery `{ sessionId, pushSubscriptionRev }`                                           | `HELLO.pushSubscriptionRev`                  |
| `STATE_FEED_UPDATED`                        | identity-only Client State Feed wake `{ feedId }`                                                             | `HELLO.stateFeedEndId` + ranged state pull   |
| `THREAD_FEED_UPDATED`                       | one-second thread-feed hint `{ threadFeedEndId, sseUuid? }`                                                   | `HELLO.threadFeedEndId` + ranged thread pull |
| `MEDIA_MESSAGE_DOWNLOAD_PROGRESS`           | temporary media-message download progress `{ threadId, seq, completedFiles, totalFiles, activeFile, status }` | terminal frame closes the temporary stream   |
| `MEDIA_FILE_DOWNLOAD_PROGRESS`              | temporary single-file byte progress `{ threadId, seq, file, loaded, total, status }`                          | terminal frame closes the temporary stream   |
| `CALL_EVENT` / `CALL_SIGNAL`                | ephemeral call lifecycle and WebRTC signaling                                                                 | active-call snapshot/new negotiation         |
| `FORCE_LOGOUT`                              | terminate a revoked session                                                                                   | authentication state                         |
| `PROFILE_AVAILABLE` / `PROFILE_UNAVAILABLE` | exact profile-resolution result wake, keyed by publisher/subject/account/revision                             | retry exact profile demand                   |
| `PROFILE_NAMESPACE_UPDATED`                 | profile namespace invalidation `{ end }`                                                                      | `/user/profile-namespace-feed`               |
| `SSE_REPLACED`                              | stop an old connection when its device session opens a new SSE                                                | new connection's `HELLO`                     |

Business projections commit before their feed wakes. `PROFILE_AVAILABLE` and `PROFILE_UNAVAILABLE` deliver session-scoped exact-resolution completion keys; `PROFILE_NAMESPACE_UPDATED` carries the namespace invalidation head. They are not message bodies or a substitute for durable feed recovery.

For a message notification candidate, the existing one-second `THREAD_FEED_UPDATED` hint includes
this device session's current `sseUuid`. Clients collect the highest `threadFeedEndId` during a **fixed
three-second window starting with the first hint** and send `POST /api/v1/events/receipt` with
`{ "sseUuid": "...", "threadFeedEndId": 42 }`. The authenticated endpoint returns `{ accepted: boolean }`
in the standard API envelope. It accepts only a head actually emitted on this session's current SSE
connection. A late confirmation for an older head cannot confirm a newer wake. A new SSE connection
for the same authenticated device session sends `SSE_REPLACED` to its old connection and closes it;
that client must stop automatic reconnects, and the old UUID no longer accepts receipts. Browser
tabs sharing one session hand ownership to the newly active tab. This proves SSE receipt, **not message read status or Android notification
display**. No idle polling or heartbeat is involved. The generated wire `id` is neither a durable
cursor nor this connection UUID.

Pending device-session push heads, deadlines, and confirmed cursors live only in the origin server's
memory. The first notification-relevant hint starts a **five-second** push window (not a leading
immediate send); later heads advance that device's target without postponing the deadline. At that
decision, the device skips FCM/Web Push only when its confirmed head covers the target head. An
unconfirmed session with live SSE rechecks current unread attention before fallback push; an offline
session receives its usual identity-only wake `{ type, threadFeedEndId }` without message content.
A backend restart within the window **loses that pending push**, by design. Deployments with multiple
backends for one origin must route the SSE and its receipt HTTP to the same process. A late receipt
can still result in both an SSE hint and a push; clients reconcile via the durable feed cursor.

> Ordering & completeness: on a live connection, strict ordering is guaranteed by TCP; state missed during a disconnect is caught up from the local Client State Feed cursor through `HELLO.stateFeedEndId`, and message bodies are caught up from per-thread cursors through each `THREAD_CONTENT_HEAD.messageEndSeq` (the stream does not replay history — no `Last-Event-ID`).

### Client → Server

SSE is unidirectional; **clients do not send business messages over SSE**. All writes (sending messages, invites, calls, future typing) go through HTTP `POST`.

## Message reports and administrative deletion

- `POST /api/v1/message-reports` accepts one `{ threadId, seq }`. It requires an authorized participant and rejects own, system, call, missing, or newly reported deleted messages. Success returns only the standard success envelope with empty data; no report identity or moderation outcome is returned to the reporter.
- Reports are unique by `(threadId, seq)`. An active duplicate succeeds without changing the row. Reporting an available message again reactivates its dismissed report. Retrying an existing report for a deleted message succeeds without reactivation.
- `POST /api/v1/admin/message-reports` accepts `{ skip?, take?, isDeleted? }`, defaulting to active reports. Content is returned unchanged. The admin UI renders raw content, or “This message has been deleted” when the message is deleted.
- `POST /api/v1/admin/message-reports/delete` accepts one `{ threadId, seq }` and soft-deletes the report without changing the message.
- `POST /api/v1/admin/messages/delete` accepts one `{ threadId, seq }` and returns `{ threadId, messageSeq, deletionSeq }` after the deletion transaction commits. Repeated submissions reuse the deletion fact. The same transaction admits client and federation content fanouts. Admin multi-selection submits one request per message and preserves failed selections for retry.

The two administrative mutations require ADMIN or SUPER_ADMIN. Report removal and message deletion are distinct: there is no review status or reporter association. The synchronous deletion transaction uses the shared deletion service to write an idempotent tombstone, update previews/reports, and admit durable thread fanout. The fanout executor subsequently publishes client and federation heads; deletion itself does not wait for that projection work. No moderation-result notification is sent to the reporter.
