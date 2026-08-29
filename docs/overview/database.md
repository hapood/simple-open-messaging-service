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

```text
Account 1─1 User                  Group 1─1 MessageThread
   │          │                                ├─N Message
   │          └─N ThreadMember N───────────────┤
   └─N ThreadParticipant N─────────────────────┘

RelationshipPair 1─N RelationshipIntent
        └────────────── optional MessageThread
```

## Model Details

### Account — local authentication and control-plane state

Only identities created by this server have an `Account`. Its primary key is
also a foreign key to the corresponding `User.id`. Password state, disablement,
the client-state allocator, read revision, sessions, push tokens, login codes,
admin linkage, and quotas reference `Account`. Federated identities never get
an `Account` row.

### User — source-scoped person identity

`User` stores only person identity and profile data. It never represents a
group. The identity key is `(account, domain, sourceDomain)`: `domain` is the
member's claimed home address, while `sourceDomain` is the feed publisher whose
profile projection supplied this row. Only users created locally use
`domain=local, sourceDomain=local`; inbound feed values are not normalized to
`local` merely because the address belongs to this server.

Fields include `id`, `account`, `domain`, `sourceDomain`, `name`, `avatar`,
`bio`, `availability`, `profileRev`, and timestamps. `availability=REMOVED`
marks a removed source projection. External users are valid `User` rows but
cannot log in because they have no `Account`.

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

| Field                                                     | Type                    | Description                                                                                             |
| --------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------- |
| `id`                                                      | Int (PK)                |                                                                                                         |
| `type`                                                    | MessageThreadType       | `P2P` \| `GROUP`                                                                                        |
| `curSeq`                                                  | Int                     | last-allocated `Message.seq` (0 = no message yet); atomic counter backing seq allocation                |
| `pullUntil`                                               | Int                     | federation pull cursor (REMOTE thread seq pulled up to); initialized when the relationship materializes |
| `lastMessageSeq` / `lastMessagePreview` / `lastMessageAt` |                         | denormalized "last message" cache for the conversation list (hot read)                                  |
| `groupId`                                                 | Int? (unique, FK→Group) | independent group profile for GROUP; null for P2P                                                       |
| `createdAt` / `updatedAt`                                 |                         |                                                                                                         |

### ThreadMember — roster and message identity

One row per `(threadId, userId)`. Every P2P thread has exactly two member rows;
group threads use the same table for their roster. `userId` points to the exact
source-scoped `User` row supplied by the relevant feed. Rows observed before a
departure are retained locally, but Group Meta does not backfill members who
left before the mirror received the roster. These rows never grant permission.

| Field                     | Type       | Description                                           |
| ------------------------- | ---------- | ----------------------------------------------------- |
| `lastSentSeq`             | Int?       | latest authored seq tracked by a locally hosted group |
| `left`                    | Boolean    | retained group projection is departed; false for P2P  |
| `role`                    | GroupRole? | OWNER/ADMIN/MEMBER (GROUP only); null for P2P         |
| `joinedAt`                | Timestamp  | start of the current observed membership interval     |
| `createdAt` / `updatedAt` | Timestamp  | retained row creation and last update                 |

The host updates `lastSentSeq`; mirrors leave it null. Group Meta does not use
this field to disclose departed speakers. `joinedAt` is local lifecycle
metadata: re-entry refreshes it, but it is not federated through GROUP_META and
must not be interpreted as the origin's join time on a mirror.

### ThreadParticipant — local account conversation state

This is an independent fact keyed by `(accountId, threadId)`. It references a
local `Account` and a `MessageThread`, never a `ThreadMember`. It stores the
local role fact, `lastReadSeq`, `readRevision`, mute/block/pin state,
`clearedSeq`, `messageVisibleBeforeSeq`, and alias. A thread may therefore have
zero, one, or several participants: a cross-server P2P usually has one, a
local-local P2P has two, and a group has one for each local account. Roster
identity is resolved separately through `ThreadMember JOIN User`.

### RelationshipPair and RelationshipIntent

- **RelationshipIntent** — one authored direction (`authorSide=A|B`) per fixed
  pair, with its own
  `note`, `requestedAt`, and absolute `expiresAt`. `REQUESTED` is displayable and
  acceptable only before expiry. Its publisher creates a placeholder thread and
  immediately grants the target peer query access; the reverse direction remains
  independent. User/user pairs use P2P threads and user/group pairs use group
  threads. A received one-sided federation request remains address-keyed and
  creates no local thread until the user accepts or independently initiates.
- **RelationshipPair.active** — the materialized bilateral fact used by
  permission checks. It is folded from the two intents under a row lock; roster
  and participant presence are never permission inputs.
- **ThreadAudience current projection** — the origin server's current federation delivery boundary. Relationship
  removal deletes the audience row and immediately revokes message and tombstone queries. Reactivation
  recreates the audience at the current thread tail and reuses the same thread/mirror. A group peer
  audience remains present while that peer has any active member. Messages from an interval with no
  active audience are neither discovered nor backfilled.

Crossed writes lock the canonical pair row before inspecting either direction. Notes remain separate;
there is no JSON merge and no polymorphic `Invite` table.

`GroupRequestProjection` is the non-authoritative manager-facing request index. Its
`direction` is `APPLICATION` for member-authored join requests and `INVITATION` for group-authored
invitations waiting for the member. Both directions share one schema, status vocabulary, paging
coordinate, retention policy, and API response shape.

### Group — independent group identity

| Field                                            | Type       | Description                                                    |
| ------------------------------------------------ | ---------- | -------------------------------------------------------------- |
| `id` / `account` / `domain`                      |            | group identity; `domain=local` only for locally created groups |
| `name` / `avatar` / `description` / `profileRev` |            | group profile, independent of `User`                           |
| `remoteGroupMetaFeedId`                          | BigInt?    | last consumed Group Meta Feed ID for a federated mirror        |
| `dissolvedAt`                                    | Timestamp? | terminal dissolve marker; null while the group remains active  |
| `createdAt` / `updatedAt`                        | Timestamp  | lifecycle timestamps                                           |

### ClientStateFeed — Client state feed

Thread, profile, member-profile, request, and client-state entries use a compacted
per-user feed. The client reads `GET /user/state-feed` after its own cursor and
applies each returned page and cursor atomically.

### UserBlock — One-way block

Independent of friendship (survives unfriend; applies to strangers too). `@@unique([blockerId, blockedId])`; mutual block = two rows. Consulted by the message path to drop fan-out and filter queries.

### Message — Message

| Field                                   | Type                 | Description                                                                                                            |
| --------------------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `id`                                    | **BigInt** (PK)      | INTERNAL surrogate, never exposed (HTTP/SSE/federation carry `seq`)                                                    |
| `seq`                                   | Int                  | positive per-thread monotonic seq, allocated atomically from `curSeq`; the external ordering key and frontend identity |
| `contentType`                           | ContentType          | `PURE_TEXT \| INVITE \| IMAGE \| VIDEO \| FILE \| AUDIO \| LINK \| CALL \| FORWARD \| GALLERY \| SYSTEM`               |
| `content`                               | String               | text / JSON / CAS-url meta (per type)                                                                                  |
| `clientMessageId`                       | VarChar(36)?, unique | send-idempotency UUID (partial unique index — NULLs distinct)                                                          |
| `originSeq`                             | Int?                 | the ORIGINATING server's per-thread seq — the cross-server value; federation dedup key + pull cursor                   |
| `originServerTime`                      | DateTime?            | sender-server allocation time (audit only; never displayed)                                                            |
| `threadId`                              |                      | conversation FK                                                                                                        |
| `creatorAccount` / `creatorDomain`      | Address snapshot     | author identity; null only for server-authored SYSTEM items                                                            |
| `createdAt` / `updatedAt` / `isDeleted` |                      |                                                                                                                        |

Unique: `(threadId, seq)` is the local timeline identity; `(threadId,
creatorAccount, creatorDomain, originSeq)` deduplicates an author's federated
sequence without coupling retained messages to a mutable `User` row.

### MediaAsset / MessageAsset / PendingMedia — Media

- **MediaAsset** — verified content-addressed blob: `digest` = sha256 of the raw bytes, stored once at `data/cas/<dd>/<dd>/<digest>` with no filename or extension. It stores `bytes` and `isDeleted`; in-flight state lives in `FileSyncProgress`. Liveness is derived from reachable messages and active staging, never a cached refcount.
- **MessageAsset** — per-object authorization index for a media-bearing message: `(messageId, threadId, digest)`. The `/uploads/cas/*` gate checks the caller's current access to a message referencing the live digest.
- **PendingMedia** — in-flight staging: a media message is NOT committed as a `Message` until its bytes are confirmed. LOCAL: `clientMessageId` idempotency + display meta (CAS url injected at promote). FEDERATED: pulled content + `originSeq` dedup; a text message quoting staged media is also retained here with `dependsOnOriginSeq` and zero files until the target receives a local `Message.seq`. `status` pending|failed. Created BEFORE the file write so a crash always leaves an attributable record for the GC. Admin clean, tombstone handling, and stale GC recursively delete dependent quote stages when the target is abandoned.

### Federation protocol-to-local mappings

The normative identities and derivation rules are defined by
[Federation v1 Message Envelope](../../spec/v1/message/envelope.md#4-identity-and-immutability) and
[Federation v1 Resources](../../spec/v1/resources.md). SOMS maps them as follows; these database
columns are implementation details and never replace the wire coordinates:

| Wire identity or coordinate                      | SOMS local representation                                                                                                                 |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `(thread, author, originSeq)`                    | `Message(threadId, creatorAccount, creatorDomain, originSeq)` unique key; local `Message.seq` remains a separate display/order coordinate |
| `(source domain, thread, quoteTarget.targetSeq)` | Resolved through the source publisher's message/receipt coordinate mapping, then projected to receiver-local `Message.seq`                |
| Direct-media `digest` bound to an outer message  | `MessageAsset(messageId, digest)` plus `MediaAsset(digest)` CAS state                                                                     |
| Remote media not yet localized                   | `PendingMedia(threadId, creatorAccount, creatorDomain, originSeq, digest)` until digest and authorization checks succeed                  |
| Outer FORWARD card root `bundleId`               | `ForwardMessage(messageId, bundleId)` → `ForwardBundle(id)`                                                                               |
| Child bundle relation                            | `ForwardBundleDependency(parentBundleId, childBundleId)`; child IDs are never substituted for the outer root ID in media requests         |
| Asset within a verified root closure             | `ForwardBundleAsset(bundleId, digest, ...)`; authorization still starts from the outer message and root bundle mapping                    |

For inbound data, `sourceDomain/sourceBundleId` records the remote opaque bundle identity while the
local `ForwardBundle.id` may use a local key. Retries must retain that mapping; shape or timestamp
similarity is not an identity substitute.

### Admin / AdminSession / AdminActionLog / 2FA / WebAuthn

- **Admin** — linked local account (`userId → Account`, 1:1); role `SUPER_ADMIN`/`ADMIN`/`VIEWER`, `enabled`, `lastLogin*`, TOTP (`twoFactorSecretCipher` AES-256-GCM under the auto-managed `./data/2fa.key`, `twoFactorLastUsedCounter` replay guard), WebAuthn hint.
- **AdminSession** — opaque admin session (`tokenHash` sha256; like the user SessionToken pattern, separate secret).
- **WebAuthnCredential** — passkey credential (public `credentialId` + COSE `publicKey`, clone-detection `counter`, transports/deviceType/backed).
- **AdminLoginChallenge** — single-use challenge tracker (closes the WebAuthn replay window for counter=0 authenticators).
- **TwoFactorBackupCode** — HMAC-SHA256(code) recovery codes (O(1) consume lookup; single-use via updateMany guard).
- **AdminActionLog** — append-only audit of `@Audit` destructive actions (`adminRole` denormalized; best-effort write).

### Federation (S2S)

- **FederatedPeer** — stable domain allow-list and recognition state. `activeNamespaceId` points to the currently verified identity namespace; `trustLevel` is `unrecognized | establishing | available | degraded | halted`; per-peer daily-quota overrides remain domain-scoped.
- **FederationNamespace** — immutable verified peer-identity epochs. Reset retires the active namespace without rewriting data already owned by it; the next successful verification creates and activates a new integer namespace.
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

1. **Account and identity are separate**: `Account` is local login/control-plane state; `User` is a source-scoped person profile. Groups live only in `Group`.
2. **Roster and local state are separate**: `ThreadMember` stores P2P/group roster facts and retained speakers. `ThreadParticipant` is an independent local-account conversation fact; neither table references the other.
3. **Requests are directional facts**: friendship and group membership keep each author's direction,
   note and revision separately; canonical pair rows serialize crossed transactions.
4. **Per-thread seq, internal id**: `Message.id` (BigInt) is an internal storage key never exposed; `seq` is the per-thread external ordering key, allocated atomically from `curSeq` (gapless). `originSeq` carries the originating server's seq for federation dedup.
5. **Client state versioning**: thread membership and profile cache entries share one integer cursor (`stateRevision` on the wire); clients delta-replay rather than re-fetch the whole list.
6. **Lifecycle is model-specific**: group departure marks `ThreadMember.left` and emits an ordered group-meta `DEPART`; it does not erase the retained member. Media-CAS blobs are reclaimed only after reachability checks.
7. **BigInt serialization**: `Message.id` / `ThreadRevision.id` / `AdminActionLog.id` etc. use BigInt, uniformly serialized to strings by the global `SerializeInterceptor` (see [architecture.md → Unified Response Format](./architecture.md#unified-response-format)).
