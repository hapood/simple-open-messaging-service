# Data Model

SOMS uses PostgreSQL (+ TimescaleDB) through Drizzle ORM and `node-postgres`. The typed schema is defined in [src/database/schema.ts](../../src/database/schema.ts), relations in [src/database/relations.ts](../../src/database/relations.ts), and deployable SQL in [database/migrations/](../../database/migrations/).

> Scope: this document covers the **consumer messaging** data model (identity, threads, messages, invites, media, sessions, admin, federation, quota). See [architecture.md](./architecture.md) for how the services use these tables.

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
   └──┬───────┬───────┬────┬─────────┬──────────────────────┬──────────────┐
      │ 1:N   │ 1:N   │1:N │1:N      │ 1:N                  │ 1:N          │ 1:1
      ▼       ▼       ▼    ▼         ▼                      ▼              ▼
 SessionToken PushToken LoginCode ThreadParticipant  ThreadRevision   RelationshipIntent
                                  (user↔thread)       (state log)      (directed facts)
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
| `profileRev` / `remoteProfileRev`       | Int / Int?    | profile revision (origin-authoritative) / mirror's last-localized revision        |
| `threadRevision`                        | Int           | internal backing value exposed to clients as the unified `stateRevision` cursor   |
| `createdAt` / `updatedAt` / `isDeleted` |               |                                                                                   |

Composite unique: `@@unique([account, domain])` — account name unique within a domain (allows a foreign stub to share a local account name). One account namespace covers users **and** admins (an admin is a linked `User` row).

The incoming-request badge is derived by each client from incoming
`RELATIONSHIP_INTENT/REQUESTED` client-state entries.
Its read/seen cursor is per-device state and is not stored by the server.

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

| Field                                                     | Type                   | Description                                                                                             |
| --------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------- |
| `id`                                                      | Int (PK)               |                                                                                                         |
| `type`                                                    | MessageThreadType      | `P2P` \| `GROUP`                                                                                        |
| `curSeq`                                                  | Int                    | last-allocated `Message.seq` (0 = no message yet); atomic counter backing seq allocation                |
| `pullUntil`                                               | Int                    | federation pull cursor (REMOTE thread seq pulled up to); initialized when the relationship materializes |
| `lastMessageSeq` / `lastMessagePreview` / `lastMessageAt` |                        | denormalized "last message" cache for the conversation list (hot read)                                  |
| `groupUserId`                                             | Int? (unique, FK→User) | the `!`-sigil group-User row (GROUP only); null for P2P                                                 |
| `createdAt` / `updatedAt`                                 |                        |                                                                                                         |

### ThreadParticipant — Membership (the single source of truth)

One row per (user, thread); P2P and GROUP share this table (`role` null for P2P). Replaces the former `UserMessageThread` + `GroupMember`.

Request processing may materialize participant rows before mutual authorization
exists. The rows provide stable thread linkage and retain per-user history state;
they do not grant access. P2P and group membership authority is derived from the
two directed relationship intents. Revocation leaves retained rows available for
read-only history.

| Field                                  | Type                   | Description                                                       |
| -------------------------------------- | ---------------------- | ----------------------------------------------------------------- |
| `lastReadSeq`                          | Int?                   | read watermark; unread = `count(Message where seq > lastReadSeq)`                 |
| `role`                                 | GroupRole?             | OWNER/ADMIN/MEMBER (GROUP only); null for P2P                                     |
| `muted` / `pinned` / `pinnedAt`        |                        | mute / pin / pin-order                                                            |
| `clearedSeq`                           | Int?                   | per-user "clear history" sequence watermark                                       |
| `alias`                                | VarChar(64)?           | per-user nickname for this thread                                                 |
| `joinedAt` / `createdAt` / `updatedAt` |                        |                                                                                   |

Unique: `@@unique([userId, threadId])`. Indexes: `[threadId]` (roster), `[userId, pinned]` (pinned-first list).

### Directed relationship facts

- **Directed account intent** — one fact per ordered account pair, with its own
  `note`, `requestedAt`, and absolute `expiresAt`. `REQUESTED` is displayable and
  acceptable only before expiry. Its publisher creates a placeholder thread and
  immediately grants the target peer query access; the reverse direction remains
  independent. User/user pairs use P2P threads and user/group pairs use group
  threads. A received one-sided federation request remains address-keyed and
  creates no local thread until the user accepts or independently initiates.
- **ThreadAudience current projection** — the origin server's current authorization fact. Relationship
  removal deletes the audience row and immediately revokes message and tombstone queries. Reactivation
  recreates the audience at the current thread tail and reuses the same thread/mirror. A group peer
  audience remains present while that peer has any active member. Messages from an interval with no
  active audience are neither discovered nor backfilled.

Crossed writes lock the canonical pair row before inspecting either direction. Notes remain separate;
there is no JSON merge and no polymorphic `Invite` table.

### Group — Group-exclusive state

Identity (name/avatar/bio) lives on the group's `!`-User row; this table holds owner + roster revision.

| Field                           | Type                  | Description                                                            |
| ------------------------------- | --------------------- | ---------------------------------------------------------------------- |
| `groupUserId`                   | Int (unique, FK→User) | the `!`-User identity row; 1:1 with the GROUP thread                   |
| `ownerId`                       | Int                   | denormalized owner (fast lookup)                                       |
| `rosterRev` / `remoteRosterRev` | Int / Int?            | origin roster revision (authoritative) / mirror's last-pulled revision |

### ThreadRevision / ProfileStateRevision — Client state log

Thread ADD/DELETE, PROFILE and other client-state entries share `User.threadRevision`, exposed on the wire as `stateRevision`. The client pulls `query-state(from,to]` and applies the fixed range atomically.

### UserBlock — One-way block

Independent of friendship (survives unfriend; applies to strangers too). `@@unique([blockerId, blockedId])`; mutual block = two rows. Consulted by the message path to drop fan-out and filter queries.

### Message — Message

| Field                                   | Type                 | Description                                                                                                             |
| --------------------------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `id`                                    | **BigInt** (PK)      | INTERNAL surrogate, never exposed (HTTP/SSE/federation carry `seq`)                                                     |
| `seq`                                   | Int                  | per-thread monotonic seq (0-indexed), allocated atomically from `curSeq`; the EXTERNAL ordering key + frontend identity |
| `contentType`                           | ContentType          | `PURE_TEXT \| INVITE \| IMAGE \| VIDEO \| FILE \| AUDIO \| LINK \| CALL \| FORWARD \| GALLERY \| SYSTEM`                |
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
- **PendingMedia** — in-flight staging: a media message is NOT committed as a `Message` until its bytes are confirmed. LOCAL: `clientMessageId` idempotency + display meta (CAS url injected at promote). FEDERATED: pulled content + `originSeq` dedup; a text message quoting staged media is also retained here with `dependsOnOriginSeq` and zero files until the target receives a local `Message.seq`. `status` pending|failed. Created BEFORE the file write so a crash always leaves an attributable record for the GC. Admin clean, tombstone handling, and stale GC recursively delete dependent quote stages when the target is abandoned.

### Federation protocol-to-local mappings

The normative identities and derivation rules are defined by
[Federation v1 Message Envelope](../../spec/v1/message/envelope.md#4-identity-and-immutability) and
[Federation v1 Resources](../../spec/v1/resources.md). SOMS maps them as follows; these database
columns are implementation details and never replace the wire coordinates:

| Wire identity or coordinate                      | SOMS local representation                                                                                                         |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `(thread, author, originSeq)`                    | `Message(threadId, creator, originSeq)` unique key; local `Message.seq` remains a separate display/order coordinate               |
| `(source domain, thread, quoteTarget.targetSeq)` | Resolved through the source publisher's message/receipt coordinate mapping, then projected to receiver-local `Message.seq`        |
| Direct-media `digest` bound to an outer message  | `MessageAsset(messageId, digest)` plus `MediaAsset(digest)` CAS state                                                             |
| Remote media not yet localized                   | `PendingMedia(threadId, creatorId, originSeq, digest)` until digest and authorization checks succeed                              |
| Outer FORWARD card root `bundleId`               | `ForwardMessage(messageId, bundleId)` → `ForwardBundle(id)`                                                                       |
| Child bundle relation                            | `ForwardBundleDependency(parentBundleId, childBundleId)`; child IDs are never substituted for the outer root ID in media requests |
| Asset within a verified root closure             | `ForwardBundleAsset(bundleId, digest, ...)`; authorization still starts from the outer message and root bundle mapping            |

For inbound data, `sourceDomain/sourceBundleId` records the remote opaque bundle identity while the
local `ForwardBundle.id` may use a local key. Retries must retain that mapping; shape or timestamp
similarity is not an identity substitute.

### Admin / AdminSession / AdminActionLog / 2FA / WebAuthn

- **Admin** — linked profile (`userId → User`, 1:1); role `SUPER_ADMIN`/`ADMIN`/`VIEWER`, `enabled`, `lastLogin*`, TOTP (`twoFactorSecretCipher` AES-256-GCM under the auto-managed `./data/2fa.key`, `twoFactorLastUsedCounter` replay guard), WebAuthn hint.
- **AdminSession** — opaque admin session (`tokenHash` sha256; like the user SessionToken pattern, separate secret).
- **WebAuthnCredential** — passkey credential (public `credentialId` + COSE `publicKey`, clone-detection `counter`, transports/deviceType/backed).
- **AdminLoginChallenge** — single-use challenge tracker (closes the WebAuthn replay window for counter=0 authenticators).
- **TwoFactorBackupCode** — HMAC-SHA256(code) recovery codes (O(1) consume lookup; single-use via updateMany guard).
- **AdminActionLog** — append-only audit of `@Audit` destructive actions (`adminRole` denormalized; best-effort write).

### Federation (S2S)

- **FederatedPeer** — domain allow-list and recognition state. `trustLevel` is `unrecognized | establishing | available | degraded | halted`; `resetInProgress` is a separate persisted maintenance-job flag; per-peer daily-quota overrides are stored alongside it.
- **FederatedPeerEvent** — append-only trust-lifecycle log (decoupled, no FK — history survives any row change).
- **S2SKeyCache** — cached peer signing keys (JWKS-style, TTL'd).
- **PeerStateFeed / PeerStateFeedTarget / PeerStateFeedPullCursor** — compacted per-peer relationship,
  profile and group state with transactional source and receiver cursors.

### QuotaDailyUsage — Unified daily-quota counters

One row per (node, UTC day, category). A node is a domain — the local `SOMS_DOMAIN` (one aggregate bucket for all local users) or a federated peer. `category` ∈ messages/images/largeFiles/requests. `@@id([domain, date, category])`; incremented via DB-atomic `INSERT … ON CONFLICT … DO UPDATE … RETURNING count` (NOT an in-process Map or Redis). Resets at 00:00 UTC, no cron.

### SystemSetting / DiagnosticsReport

- **SystemSetting** — generic key→value for operator runtime configuration; application-owned cryptographic keys are not stored here.
- **DiagnosticsReport** — client-uploaded support bundle (gzip tar of Rust logs + webview console + manifest); `bundlePath` under `data/diagnostics/`, sha256-addressed; soft-deleted, the blob file is hard-unlinked by GC.

## Enums

```sql
CREATE TYPE "PushPlatform"            AS ENUM ('ANDROID', 'WEB', 'IOS');
CREATE TYPE "MessageThreadType"       AS ENUM ('P2P', 'GROUP');
CREATE TYPE "GroupRole"               AS ENUM ('OWNER', 'ADMIN', 'MEMBER');   -- GROUP only; null for P2P
CREATE TYPE "InviteKind"              AS ENUM ('FRIEND', 'GROUP');
CREATE TYPE "InviteStatus"            AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'REVOKED', 'EXPIRED');
CREATE TYPE "ThreadRevisionDirection" AS ENUM ('ADD', 'DELETE');

CREATE TYPE "ContentType" AS ENUM (
  'PURE_TEXT', 'INVITE', 'IMAGE', 'VIDEO', 'FILE', 'AUDIO', 'LINK',
  'CALL', 'FORWARD', 'GALLERY', 'SYSTEM'
);

CREATE TYPE "AdminRole" AS ENUM ('SUPER_ADMIN', 'ADMIN', 'VIEWER');
```

## Design Notes

1. **One account namespace**: users and admins share `User`; an admin is a linked profile, so user/admin account names can never collide. A `!`-sigil `User` row (`isGroup`) is a group identity — `Group` holds only owner + roster revision.
2. **Conversation linkage is `ThreadParticipant`**: P2P and GROUP share one participant table (`role` null for P2P). RelationshipIntent is the sole current authorization source; retained participant rows preserve per-user settings and read-only history after revocation.
3. **Requests are directional facts**: friendship and group membership keep each author's direction,
   note and revision separately; canonical pair rows serialize crossed transactions.
4. **Per-thread seq, internal id**: `Message.id` (BigInt) is an internal storage key never exposed; `seq` is the per-thread external ordering key, allocated atomically from `curSeq` (gapless). `originSeq` carries the originating server's seq for federation dedup.
5. **Client state versioning**: thread membership and profile cache entries share one integer cursor (`stateRevision` on the wire); clients delta-replay rather than re-fetch the whole list.
6. **Lifecycle is model-specific**: revoked relationship intents can leave retained participants for visible read-only history. Media-CAS blobs are reclaimed only after reachability checks.
7. **BigInt serialization**: `Message.id` / `ThreadRevision.id` / `AdminActionLog.id` etc. use BigInt, uniformly serialized to strings by the global `SerializeInterceptor` (see [architecture.md → Unified Response Format](./architecture.md#unified-response-format)).
