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
   │                                      ├─N Message
   └─N AccountThreadState N────────────────┤
                                          └─1 GroupMetaFeed  (canonical or replica)

RelationshipPair 1─N RelationshipIntent
        ├────────────── optional MessageThread
        └────────────── two source-correct endpoints

DurableTask (self-reference through parentTaskId and supersededByTaskId)
```

## Model Details

### Account — local authentication and control-plane state

Only identities created by this server have an `Account`. Its primary key is
also a foreign key to the corresponding `User.id`. Password state, disablement,
the client-state allocator, read revision, sessions, push tokens, login codes,
admin linkage, and quotas reference `Account`. Federated identities never get
an `Account` row.

### User — namespace-scoped person identity

`User` stores only person identity and profile data. It never represents a
group. The identity key is `(account, domain, namespaceId)`: `domain` is the
person's claimed home address, while `namespaceId` identifies the local or
verified remote identity epoch that materialized this projection. The namespace
already determines its publisher domain, so `User` does not duplicate that
domain in a `sourceDomain` column. Inbound feed values are not normalized to the
local namespace merely because the claimed address belongs to this server.

Fields include `id`, `account`, `domain`, `namespaceId`, `name`, `avatar`,
`bio`, `availability`, `defaultProfileRev`, and timestamps.
`availability=REMOVED` marks a removed source projection. External users are
valid `User` rows but cannot log in because they have no `Account`.

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

One row per registered device session; `token` is globally unique (FCM registration token for ANDROID,
push endpoint URL for WEB) and is re-owned to the current authenticated session on registration. The required
`sessionId` references `SessionToken`, allowing message Push to be suppressed only when that exact session
already owns a live SSE connection. `deviceId` remains optional diagnostic metadata. WEB rows also carry the
subscription's `webP256dh` + `webAuth`; `platform` is `ANDROID`/`WEB`/`IOS`. Every session soft-revoke path
deletes its associated Push rows in the same transaction, so revoked and expired devices do not remain in the
operational registration set.

### MessageThread — Conversation

| Field                                                     | Type                    | Description                                                                                             |
| --------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------- |
| `id`                                                      | Int (PK)                |                                                                                                         |
| `type`                                                    | MessageThreadType       | `P2P` \| `GROUP`                                                                                        |
| `curSeq`                                                  | Int                     | last-allocated `Message.seq` (0 = no message yet); atomic counter backing seq allocation                |
| `clearedSeq`                                              | Int?                    | inclusive history boundary shared by every viewer; messages at or below it are unavailable              |
| `pullUntil`                                               | Int                     | federation pull cursor (REMOTE thread seq pulled up to); initialized when the relationship materializes |
| `lastMessageSeq` / `lastMessagePreview` / `lastMessageAt` |                         | denormalized "last message" cache for the conversation list (hot read)                                  |
| `groupId`                                                 | Int? (unique, FK→Group) | independent group profile for GROUP; null for P2P                                                       |
| `createdAt` / `updatedAt`                                 |                         |                                                                                                         |

### P2P endpoint resolution

There is no `ThreadMember` table. A P2P `RelationshipPair` owns the two
source-correct endpoint Addresses and its optional `threadId`; this is sufficient
to resolve both identities and find the opposite endpoint. `active` is the
authorization fact, while the two `RelationshipIntent.profileRev` values retain
the revisions selected by the current relationship flow. Every message retains
its own immutable author Address and `profileRev`.

### AccountThreadState — local account conversation state

This is an independent fact keyed by `(accountId, threadId)`. It references a
local `Account` and a `MessageThread`. It stores the
local role fact, `lastReadSeq`, `readRevision`, mute/block/pin state,
inclusive `messageVisibleThroughSeq`, and alias. The thread-wide `clearedSeq` history boundary lives
on `MessageThread`. A thread may therefore have
zero, one, or several participants: a cross-server P2P usually has one, a
local-local P2P has two, and a group has one for each local account. Roster
identity is resolved from canonical Group Meta for a locally hosted group and
from the replicated Group Meta for a remote group.

### RelationshipPair and RelationshipIntent

- **RelationshipIntent** — one authored direction (`authorSide=A|B`) per fixed
  pair, with its own
  `note`, `requestedAt`, and absolute `expiresAt`. `REQUESTED` is displayable and
  acceptable only before expiry. Its publisher creates the stable query state
  before publishing the direction, which immediately grants passive query access
  to the target peer without enabling content-head notification. The reverse
  direction remains independent. User/user pairs use P2P threads and user/group pairs use group
  threads. A received one-sided federation request remains address-keyed and
  creates no local thread until the user accepts or independently initiates.
- **RelationshipPair.active** — the materialized bilateral fact used by sends,
  content-head publication, and other mutually confirmed operations. It is
  folded from the two intents under a row lock; roster and participant presence
  are never permission inputs.
- **ThreadAudience current projection** — the group origin server's current federation notification and delivery boundary. It also stores the
  canonical Group Meta delta visibility floor established on authorization or reauthorization. Relationship
  removal deletes the audience row and stops head publication. Intent revocation independently
  revokes passive message and tombstone queries. Reactivation reuses the same thread/mirror. By default,
  a newly created or recreated audience may query all retained history; the local
  `federation:audience:historyAccessEnabled` setting can instead place its access floor at the current
  thread tail. This is a serving policy rather than a wire-protocol guarantee. A group peer audience
  remains present while that peer has any active member. A remote-group mirror
  has no `ThreadAudience`; its local account projections use
  `AccountThreadState`, and the group address identifies its sole authority.

Crossed writes lock the canonical pair row before inspecting either direction. Notes remain separate;
there is no JSON merge and no polymorphic `Invite` table.

`GroupRequestProjection` is the non-authoritative manager-facing request index. Its
`direction` is `APPLICATION` for member-authored join requests and `INVITATION` for group-authored
invitations waiting for the member. Both directions share one schema, status vocabulary, paging
coordinate, retention policy, and API response shape.

### DurableTask — mutation and projection work

`DurableTask` stores retained operational history for asynchronous mutations
and paginated projections. It is not authoritative relationship or group state.
`kind` separates `MUTATION` and `PROJECTION` execution lanes, while `scopeType`
and `scopeKey` identify the ordering boundary. At most one row for a
`(kind, scopeKey)` lane may be `PROCESSING`.

`payload` is immutable after claim. An eligible pending group-member intent
slot may be rewritten in place to its latest desired value before execution.
Required JSON object `checkpoint` stores type-specific resumable progress.
`parentTaskId` links fan-out work. `coalescingKey` identifies both in-place
mutation slots and replace-by-successor projections; `SUPERSEDED` and
`supersededByTaskId` retain the latter's replacement history. See
[Durable Task Scheduling](../design/durable-task-scheduling.md) for execution
and failure semantics.

### Group — independent group identity

| Field                                            | Type       | Description                                                    |
| ------------------------------------------------ | ---------- | -------------------------------------------------------------- |
| `id` / `account` / `domain`                      |            | group identity; `domain=local` only for locally created groups |
| `name` / `avatar` / `description` / `profileRev` |            | group profile, independent of `User`                           |
| `remoteGroupMetaFeedId`                          | BigInt?    | last consumed Group Meta Feed ID for a federated mirror        |
| `dissolvedAt`                                    | Timestamp? | terminal dissolve marker; null while the group remains active  |
| `createdAt` / `updatedAt`                        | Timestamp  | lifecycle timestamps                                           |

### Canonical Group Meta — origin-owned roster

A locally hosted group has one Group Meta allocator and append log. Canonical
member and group-profile rows are keyed by `groupId`, never by a target peer.
The latest operation for a stable member is the authoritative local roster:
`UPSERT` is current and `DEPART` is absent. `ThreadAudience` supplies current
peer authorization and its delta visibility floor; it does not own a roster
copy.

`GroupMetaMemberFeed` stores `UPSERT { role, profileRev }` and internally stores
an empty body for `DEPART`; federation serialization omits the body entirely.
`GroupMetaProfileFeed` is the compacted group-profile reference in the same
group coordinate space.

A mirror stores the consumed cursor and each validated remote item once in a
group-scoped replica using the remote canonical coordinates. The newest
operation per stable member is its current roster projection; no mirror
`ThreadMember` rows or separate delivery log exist. The replica is shared by
all local accounts and is not authoritative roster state. Local account rows
contain only compacted Client State Feed heads and device cursors. An origin
serves local clients directly from its canonical log, while a mirror serves
them from the replica.

Delta and full rounds both fix a remote `through` and may use multiple bounded
pages. Page transactions update replica facts and recovery progress only; they
do not advance the mirror's `feedEndId`, allocate a Client State Feed head, or
emit a wake hint. Full pages additionally tag observed rows with a
durable `fullSyncRunId`, followed by bounded removal of unobserved rows. One
short final transaction advances `feedEndId`. Delta and full application
serialize per mirrored group. There is no local read gate during the round.

On an origin, `feedEndId` is the allocation end. On a mirror, it is the last
completely applied round cursor. A State Feed Group Meta head supplies the
sub-round target through its durable task payload; progress remains in the task
checkpoint. The State Feed item commits only after `feedEndId` reaches its
target, and no Group Meta network read occurs inside that item transaction.

### ClientStateFeed — Client state feed

Thread, profile, member-profile, request, and client-state entries use one
compacted per-user feed. `THREAD_CONTENT_HEAD` stores required message and
tombstone ends together. The client reads
`GET /user/state-feed` after its sole device-feed cursor and applies each page
and cursor atomically. There are no separate device message or tombstone feed
tables.

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
| `originSeq`                             | Int?                 | source-scoped message coordinate (non-null for user messages); used with `sourceNamespaceId` and `threadId` for deduplication, receipt association, and quote resolution; not a global ID or a standalone pull cursor |
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
| Direct incoming `(publisher, thread, seq)`       | Captured publisher namespace plus `Message(threadId, sourceNamespaceId, originSeq)`; local `Message.seq` is a separate display/order coordinate |
| `quoteTarget.seq`                               | Durable `quote: { seq, namespaceId: capturedPublisherNamespace }`; resolve by thread, source namespace, and origin sequence at read time |
| `quoteTarget.originSeq`                         | Durable `quote: { seq: originSeq, namespaceId: 0 }`; already addresses the receiver's local thread sequence |
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
- **AdminActionLog** — lifecycle audit of `@Audit` destructive actions (`adminRole` denormalized). A `STARTED` row is required before execution and is finalized as `SUCCEEDED` or `FAILED`; a stranded `STARTED` row means the outcome is unknown.

### Federation (S2S)

- **FederatedPeer** — stable domain recognition and reachability state. `activeNamespaceId` points to the currently verified identity namespace. `outboundRecognitionConfirmed` records delivery of this node's Recognize notification. `inboundRecognitionConfirmed` records evidence that the peer recognizes this node, supplied by either its Recognize notification or a valid `available`/`degraded` Health result. `trustLevel` is `unrecognized | establishing | available | degraded | halted`; the successful Health states both confirm recognition while distinguishing current reachability quality. Per-peer daily-quota overrides remain domain-scoped.
- **FederationNamespace** — immutable verified peer-identity epochs. Reset retires the active namespace without rewriting data already owned by it; the next successful verification creates and activates a new integer namespace.
- **FederatedPeerEvent** — append-only trust-lifecycle log (decoupled, no FK — history survives any row change).
- **S2SKeyCache** — cached peer signing keys (JWKS-style, TTL'd).
- **PeerStateFeed / PeerStateFeedTarget / PeerStateFeedPullCursor** — compacted
  per-peer relationship and group/thread heads with transactional source and
  receiver cursors. Delta and cursor-unavailable full consumption both use a
  fixed-through paginated round; page commits persist facts without outward
  notification, and round completion emits coalesced wakes.
- **Canonical Group Meta feeds** — one allocator and member/profile coordinate
  space per locally hosted group. Audience-specific state contains authorization
  and visibility boundaries only; it never duplicates roster items.

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
2. **Membership storage follows relationship kind**: canonical Group Meta
   stores a locally hosted group's authoritative roster; the same storage shape
   holds a remote group's validated non-authoritative replica. P2P participants
   are the two `RelationshipPair` endpoints. `AccountThreadState` remains
   independent local-account conversation state. No `ThreadMember` table is
   retained.
3. **Requests are directional facts**: friendship and group membership keep each author's direction,
   note and revision separately; canonical pair rows serialize crossed transactions.
4. **Per-thread seq, internal id**: `Message.id` (BigInt) is an internal storage key never exposed; `seq` is the per-thread external ordering key, allocated atomically from `curSeq` (gapless). `originSeq` carries the originating server's seq for federation dedup.
5. **Client state versioning**: thread membership, profile cache entries, requests, and compacted
   `THREAD_CONTENT_HEAD` rows share the account's `stateFeedAllocatedThrough` coordinate. Clients persist
   one Client State Feed cursor and delta-replay through the `stateFeedEndId` advertised by `HELLO` or
   `STATE_FEED_UPDATED` rather than re-fetching the whole list.
6. **Lifecycle is model-specific**: the origin appends bodyless Group Meta
   `DEPART`; mirrors and clients physically delete current member projections.
   Historical messages retain their own author Address and profile reference.
   Media-CAS blobs are reclaimed only after reachability checks.
7. **BigInt serialization**: `Message.id` / `ThreadRevision.id` / `AdminActionLog.id` etc. use BigInt, uniformly serialized to strings by the global `SerializeInterceptor` (see [architecture.md → Unified Response Format](./architecture.md#unified-response-format)).
