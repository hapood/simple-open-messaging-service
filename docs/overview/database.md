# Data Model

SOMS uses PostgreSQL (+ TimescaleDB) through Drizzle ORM and `node-postgres`. The typed schema is defined in [src/database/schema.ts](../../src/database/schema.ts), relations in [src/database/relations.ts](../../src/database/relations.ts), and deployable SQL in [database/migrations/](../../database/migrations/).

> Scope: this document covers the **consumer messaging** data model (identity, threads, messages, invites, media, sessions, admin, federation, quota). Rows are **soft-deleted only** (`isDeleted` / `revokedAt` / `leftAt`); the only hard-deletes are media-CAS blobs reclaimed at refcount 0. See [architecture.md](./architecture.md) for how the services use these tables.

## Table of Contents

- [Relation Overview](#relation-overview)
- [Model Details](#model-details)
- [Enums](#enums)
- [Design Notes](#design-notes)

---

## Relation Overview

```
   ┌─────────────────────────────────┐
   │              User               │   identity (account/name/avatar/bio inline;
   │  account · hashPwd · domain     │    isGroup flags "!"-sigil group-identity rows)
   │  profileRev · threadRevision    │
   │  friendReqAckRev                │
   └──┬───────┬───────┬────┬─────────┬──────────────────────┬──────────────┐
      │ 1:N   │ 1:N   │1:N │1:N      │ 1:N                  │ 1:N          │ 1:1
      ▼       ▼       ▼    ▼         ▼                      ▼              ▼
 SessionToken PushToken LoginCode ThreadParticipant  ThreadRevision     Invite(FRIEND/GROUP)
                                  (user↔thread)       (thread-list log)  (from/to)
                                          │
                                          ▼ N:1
                                  ┌─────────────────┐  1:1   ┌────────┐
                                  │  MessageThread  │◀──────▶│  Group │ (GROUP only — "!"-User identity)
                                  │  P2P | GROUP    │        └────────┘
                                  │  curSeq·pullUntil│
                  ┌───────────────┤  lastMessage*    │
                  │               └────┬─────────────┘
                  │ 1:N                │ 1:N
                  ▼                    ▼
   ┌──────────────────────┐    ┌──────────────────┐
   │ PendingMedia(staging)│    │     Message      │ seq·originSeq·clientMessageId
   └──────────────────────┘    │ contentType incl │──────── MediaMessage ──▶ MediaAsset (sha256 CAS)
                               │  CALL/LINK/AUDIO │
                               └──────────────────┘

   Standalone: UserBlock (one-way block) · Admin* · FederatedPeer(+Event) · S2S* · QuotaDailyUsage ·
               SystemSetting · DiagnosticsReport
```

## Model Details

### User — Identity (humans + group-identity rows)

| Field                                   | Type          | Description                                                                       |
| --------------------------------------- | ------------- | --------------------------------------------------------------------------------- |
| `id`                                    | Int (PK)      |                                                                                   |
| `account`                               | VarChar(31)   | user = `letters+dot`; group = `!`+ULID; case-insensitive on write                 |
| `hashPwd`                               | VarChar(127)? | argon2 hash; **null = OTP/QR-only account** (no password)                         |
| `mustChangePassword`                    | Boolean       | true = admin-generated INITIAL password the user must rotate (one-time bootstrap) |
| `name` / `avatar` / `bio`               | String        | display name / avatar path / bio — **folded in** from the former `UserExtra`      |
| `isForeigner`                           | Boolean       | cross-domain (federated) user                                                     |
| `isGroup`                               | Boolean       | true iff a `!`-sigil group-identity row (mirrors account grammar)                 |
| `domain`                                | VarChar(63)   | `"local"` for users on THIS server; `<peer-domain>` for a federated stub          |
| `friendReqAckRev`                       | DateTime      | friend-request read cursor; badge = `friendReqRev > friendReqAckRev`              |
| `profileRev` / `remoteProfileRev`       | Int / Int?    | profile revision (origin-authoritative) / mirror's last-localized revision        |
| `threadRevision`                        | Int           | per-user thread-list revision (the delta cursor)                                  |
| `createdAt` / `updatedAt` / `isDeleted` |               |                                                                                   |

Composite unique: `@@unique([account, domain])` — account name unique within a domain (allows a foreign stub to share a local account name). One account namespace covers users **and** admins (an admin is a linked `User` row).

### SessionToken — the single session credential

Opaque `randomBytes(32)`, sha256-hashed at rest; plaintext returned once at login. Replaces the legacy access+refresh JWT pair.

| Field                                        | Type                 | Description                                                                                               |
| -------------------------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------- |
| `tokenHash`                                  | VarChar(127), unique | sha256 hash (never plaintext)                                                                             |
| `client`                                     | VarChar(16)          | `app` \| `web` \| `desktop` (device icon/label)                                                           |
| `device` / `userAgent` / `ip` / `lastSeenIp` |                      | device label / raw UA / sign-in IP / last-seen IP                                                         |
| `trusted`                                    | Boolean              | true → `expiresAt` NULL (permanent, revocation-only — token in OS secure storage); false → sliding 14-day |
| `expiresAt`                                  | DateTime?            | null = never (trusted); set = sliding 14-day deadline (untrusted)                                         |
| `lastSeenAt`                                 | DateTime             | sliding-window activity tracker                                                                           |
| `persistent`                                 | Boolean              | web/desktop cookie persistence (14d sliding vs session)                                                   |
| `revokedAt` / `revokeReason`                 |                      | soft revoke; reason ∈ logout/device_revoke/all_devices/password_change/admin_disable/admin_purge          |

Index: `@@index([userId])`.

### LoginCode — admin-issued OTP (Android app-session login)

| Field                                          | Type         | Description                                                           |
| ---------------------------------------------- | ------------ | --------------------------------------------------------------------- |
| `codeHash`                                     | VarChar(127) | argon2 hash of the 6-digit code; plaintext never stored               |
| `issuedBy` / `issuedAt` / `expiresAt`          |              | admin issuer / issue / +10 min expiry                                 |
| `consumedAt` / `consumedIp` / `consumedDevice` |              | single-use guard (`consumedAt: null` precondition via updateMany)     |
| `producedSessionId`                            | Int?         | the `SessionToken.id` it created (audit link; intentionally NOT a FK) |
| `revokedAt`                                    |              | admin-revoked (only an unused code)                                   |

### PushToken — push registration

One row per (device, user); `token` globally unique (FCM registration token for ANDROID, push endpoint URL for WEB). Re-owned to the current user on re-register. WEB rows also carry the subscription's `webP256dh` + `webAuth`. `platform` ∈ `ANDROID`/`WEB`/`IOS`; `lastSeenAt` feeds a future stale-token sweep.

### MessageThread — Conversation

| Field                                                     | Type                   | Description                                                                          |
| --------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------ |
| `id`                                                      | Int (PK)               |                                                                                      |
| `type`                                                    | MessageThreadType      | `P2P` \| `GROUP`                                                                     |
| `curSeq`                                                  | Int                    | last-allocated `Message.seq` (-1 = none); atomic counter backing seq allocation      |
| `pullUntil`                                               | Int                    | federation pull cursor (REMOTE thread seq pulled up to); seeded by invite `sinceSeq` |
| `lastMessageSeq` / `lastMessagePreview` / `lastMessageAt` |                        | denormalized "last message" cache for the conversation list (hot read)               |
| `groupUserId`                                             | Int? (unique, FK→User) | the `!`-sigil group-User row (GROUP only); null for P2P                              |
| `createdAt` / `updatedAt`                                 |                        |                                                                                      |

### ThreadParticipant — Membership (the single source of truth)

One row per (user, thread); P2P and GROUP share this table (`role` null for P2P). Replaces the former `UserMessageThread` + `GroupMember`.

| Field                                  | Type         | Description                                                       |
| -------------------------------------- | ------------ | ----------------------------------------------------------------- |
| `lastReadSeq`                          | Int?         | read watermark; unread = `count(Message where seq > lastReadSeq)` |
| `role`                                 | GroupRole?   | OWNER/ADMIN/MEMBER (GROUP only); null for P2P                     |
| `muted` / `pinned` / `pinnedAt`        |              | mute / pin / pin-order                                            |
| `clearedSeq`                           | Int?         | per-user "clear history" sequence watermark                       |
| `alias`                                | VarChar(64)? | per-user nickname for this thread                                 |
| `leftAt`                               | DateTime?    | soft-leave / hidden (null = active)                               |
| `joinedAt` / `createdAt` / `updatedAt` |              |                                                                   |

Unique: `@@unique([userId, threadId])`. Indexes: `[threadId]` (roster), `[userId, pinned]` (pinned-first list).

### Invite — Friend-add + Group-invite (unified)

| Field                     | Type         | Description                                                      |
| ------------------------- | ------------ | ---------------------------------------------------------------- |
| `kind`                    | InviteKind   | `FRIEND` \| `GROUP`                                              |
| `fromUserId` / `toUserId` | Int          | inviter / decision-maker                                         |
| `threadId`                | Int?         | GROUP: target group; FRIEND: null (P2P thread minted on accept)  |
| `note`                    | VarChar(255) | invite message                                                   |
| `status`                  | InviteStatus | `PENDING → ACCEPTED \| REJECTED \| REVOKED \| EXPIRED`           |
| `expiresAt`               | DateTime     | 7d; validated at accept time (background sweep deferred)         |
| `origin` / `originId`     | VarChar      | minting server domain / id — `(origin, originId)` delivery dedup |

Rows are never hard-deleted (kept as history). The database has a unique constraint on
`(origin, originId)`; unique-conflict handling deduplicates FRIEND on `(from, to)` and GROUP on
`(to, thread)` regardless of inviter.

### Group — Group-exclusive state

Identity (name/avatar/bio) lives on the group's `!`-User row; this table holds owner + roster revision.

| Field                           | Type                  | Description                                                            |
| ------------------------------- | --------------------- | ---------------------------------------------------------------------- |
| `groupUserId`                   | Int (unique, FK→User) | the `!`-User identity row; 1:1 with the GROUP thread                   |
| `ownerId`                       | Int                   | denormalized owner (fast lookup)                                       |
| `rosterRev` / `remoteRosterRev` | Int / Int?            | origin roster revision (authoritative) / mirror's last-pulled revision |

### ThreadRevision — Thread-list operation log

Per-user ADD/DELETE log; one row per (user, thread, direction). `revision` = the user's `threadRevision` at operation time. The client pulls deltas via `query-thread(from, to]`. `@@unique([userId, threadId, direction])` — at most one ADD + one DELETE per (user, thread).

### UserBlock — One-way block

Independent of friendship (survives unfriend; applies to strangers too). `@@unique([blockerId, blockedId])`; mutual block = two rows. Consulted by the message path to drop fan-out and filter queries.

### Message — Message

| Field                                   | Type                 | Description                                                                                                             |
| --------------------------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `id`                                    | **BigInt** (PK)      | INTERNAL surrogate, never exposed (HTTP/SSE/federation carry `seq`)                                                     |
| `seq`                                   | Int                  | per-thread monotonic seq (0-indexed), allocated atomically from `curSeq`; the EXTERNAL ordering key + frontend identity |
| `contentType`                           | ContentType          | `PURE_TEXT \| INVITE \| IMAGE \| VIDEO \| FILE \| AUDIO \| LINK \| CALL`                                                |
| `content`                               | String               | text / JSON / CAS-url meta (per type)                                                                                   |
| `clientMessageId`                       | VarChar(36)?, unique | send-idempotency UUID (partial unique index — NULLs distinct)                                                           |
| `originSeq`                             | Int?                 | the ORIGINATING server's per-thread seq — the cross-server value; federation dedup key + pull cursor                    |
| `originServerTime`                      | DateTime?            | sender-server allocation time (audit only; never displayed)                                                             |
| `threadId` / `creator`                  |                      | FKs                                                                                                                     |
| `createdAt` / `updatedAt` / `isDeleted` |                      |                                                                                                                         |

Unique: `@@unique([threadId, seq])` (seq identity + keyset cursor), `@@unique([threadId, creator, originSeq])` (sender seq-allocation race + receiver pull dedup).

### MediaAsset / MediaMessage / PendingMedia — Media

- **MediaAsset** — content-addressed asset: `digest` = sha256 of the raw bytes, stored once at `data/cas/<dd>/<dd>/<digest>` with no filename or extension. It stores `bytes` and `PENDING | READY | DELETING | DELETED`; GC retains `DELETED` tombstones. Liveness is derived from non-deleted ordinary messages and active staging, never a cached refcount; forward bundles deliberately do not keep blobs alive.
- **MediaMessage** — per-object authz index (1:1 with a media-bearing Message): `(messageId, threadId, digest)`. The `/uploads/cas/*` gate answers "may this user read this READY digest?" with one indexed EXISTS joined to ThreadParticipant.
- **PendingMedia** — in-flight staging: a media message is NOT committed as a `Message` until its bytes are confirmed. LOCAL: `clientMessageId` idempotency + display meta (CAS url injected at promote). FEDERATED: pulled content + `originSeq` dedup. `status` pending|failed. Created BEFORE the file write so a crash always leaves an attributable record for the GC.

### Admin / AdminSession / AdminActionLog / 2FA / WebAuthn

- **Admin** — linked profile (`userId → User`, 1:1); role `SUPER_ADMIN`/`ADMIN`/`VIEWER`, `enabled`, `lastLogin*`, TOTP (`twoFactorSecretCipher` AES-256-GCM under the auto-managed `./data/2fa.key`, `twoFactorLastUsedCounter` replay guard), WebAuthn hint.
- **AdminSession** — opaque admin session (`tokenHash` sha256; like the user SessionToken pattern, separate secret).
- **WebAuthnCredential** — passkey credential (public `credentialId` + COSE `publicKey`, clone-detection `counter`, transports/deviceType/backed).
- **AdminLoginChallenge** — single-use challenge tracker (closes the WebAuthn replay window for counter=0 authenticators).
- **TwoFactorBackupCode** — HMAC-SHA256(code) recovery codes (O(1) consume lookup; single-use via updateMany guard).
- **AdminActionLog** — append-only audit of `@Audit` destructive actions (`adminRole` denormalized; best-effort write).

### Federation (S2S)

- **FederatedPeer** — domain allow-list (trust data only; keys fetched from `/.well-known/soms`). `trustLevel` `pending → trusted → demoted → trusted…` (+ `blocked`); per-peer daily-quota overrides.
- **FederatedPeerEvent** — append-only trust-lifecycle log (decoupled, no FK — history survives any row change).
- **S2SKeyCache** — cached peer signing keys (JWKS-style, TTL'd).
- **S2SFriendOpSeen** — inbound friend-op dedup `(origin, opId)`.

### QuotaDailyUsage — Unified daily-quota counters

One row per (node, UTC day, category). A node is a domain — the local `SOMS_DOMAIN` (one aggregate bucket for all local users) or a federated peer. `category` ∈ messages/images/largeFiles/requests. `@@id([domain, date, category])`; incremented via DB-atomic `INSERT … ON CONFLICT … DO UPDATE … RETURNING count` (NOT an in-process Map or Redis). Resets at 00:00 UTC, no cron.

### SystemSetting / DiagnosticsReport

- **SystemSetting** — generic key→value for operator runtime config (VAPID keypair, Firebase config, login mode, …); typed facade in `SettingsService`.
- **DiagnosticsReport** — client-uploaded support bundle (gzip tar of Rust logs + webview console + manifest); `bundlePath` under `data/diagnostics/`, sha256-addressed; soft-deleted, the blob file is hard-unlinked by GC.

## Enums

```prisma
enum PushPlatform { ANDROID  WEB  IOS }
enum MessageThreadType { P2P  GROUP }
enum GroupRole { OWNER  ADMIN  MEMBER }        // GROUP only; null for P2P
enum InviteKind { FRIEND  GROUP }
enum InviteStatus { PENDING  ACCEPTED  REJECTED  REVOKED  EXPIRED }
enum ThreadRevisionDirection { ADD  DELETE }

enum ContentType {
  PURE_TEXT  INVITE  IMAGE  VIDEO  FILE  AUDIO  LINK
  CALL       // 1:1 WebRTC call record — SERVER-AUTHORED ONLY (CallsService writes the terminal bubble)
}

enum AdminRole { SUPER_ADMIN  ADMIN  VIEWER }
```

## Design Notes

1. **One account namespace**: users and admins share `User`; an admin is a linked profile, so user/admin account names can never collide. A `!`-sigil `User` row (`isGroup`) is a group identity — `Group` holds only owner + roster revision.
2. **Membership is `ThreadParticipant`**: P2P and GROUP share one membership table (`role` null for P2P). There is no polymorphic `UserMessageThread` and no separate `GroupMember`. Mute/pin/clear/alias/leave are per-participant columns.
3. **Invites are unified**: friend-add and group-invite are one `Invite` table (`FRIEND`/`GROUP`); the legacy JWT-token-in-message group invite is retired. Rows are never hard-deleted.
4. **Per-thread seq, internal id**: `Message.id` (BigInt) is an internal storage key never exposed; `seq` is the per-thread external ordering key, allocated atomically from `curSeq` (gapless). `originSeq` carries the originating server's seq for federation dedup.
5. **Thread-list versioning**: `ThreadRevision` is a per-user ADD/DELETE log keyed by `User.threadRevision`; clients delta-replay rather than re-fetch the whole list.
6. **Soft-delete only**: DB rows are never purged (`isDeleted`/`revokedAt`/`leftAt`); only media-CAS blobs are hard-deleted by an explicit manual cleanup after live-message/staging reachability is checked.
7. **BigInt serialization**: `Message.id` / `ThreadRevision.id` / `AdminActionLog.id` etc. use BigInt, uniformly serialized to strings by the global `SerializeInterceptor` (see [architecture.md → Unified Response Format](./architecture.md#unified-response-format)).
