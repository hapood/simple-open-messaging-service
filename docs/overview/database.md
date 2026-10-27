# Data Model

SOMS uses PostgreSQL (+ TimescaleDB) through Drizzle ORM and `node-postgres`.
The typed schema is defined in [schema.ts](../../src/database/schema.ts),
relations in [relations.ts](../../src/database/relations.ts), and deployable SQL
in [database/migrations/](../../database/migrations/).

This is an implementation overview, not the federation wire contract. Wire
coordinates and authorization are defined separately in [spec/](../../spec/README.md).
The descriptions below use current physical table names; domain facades may
present a joined view without introducing another table.

## Identity and profiles

### Account

`Account` is the local user identity and authentication/control-plane aggregate.
It owns the immutable account name, namespace `0`, `defaultProfileRev`,
availability, password state, disablement, and both client feed allocators
(`clientStateFeedEndId` and `threadFeedEndId`). Its `kind` distinguishes ordinary
users from the disabled reserved `$system` sender. Foreign subjects never get
an `Account` row. There is no separate `User` table or foreign-user stub table.

Sessions, local-account quotas, preferences, and administrator linkage reference
`Account.id`. A source-level `user` or `userId` alias does not imply another
physical identity table.

### GroupAccount and MessageThread

`GroupAccount` owns only a locally authored group's immutable account name,
selected profile revision, and dissolution marker. A mirrored group has no local
`GroupAccount`. Both local groups and mirrors have a `MessageThread` carrying
the group address and `authorityNamespaceId`; a local group also has
`groupAccountId`. Group business facades join these records with `GroupMeta`
and profiles. There is no physical `Group` table.

### Profile

`Profile` stores immutable display snapshots: `displayName`, inline avatar,
`bio`, and creation time. The primary key is:

```text
(publisherNamespaceId, account, profileNamespaceId, profileRev)
```

`publisherNamespaceId` identifies the locally recognized publisher that owns or
disclosed the snapshot. `profileNamespaceId` is the subject's coordinate in that
publisher's namespace space. They are not interchangeable. Revisions are
positive; revision `0` on a reference means there is no selected snapshot.
Names and avatars are not mutable columns on `Account` or `GroupAccount`.

`ProfileNamespace`, `ProfileNamespaceFeed`, `ProfileNamespaceChangeFeed`, and
`ProfileNamespaceChangeFeedHead` support binding resolution, expiry, and client
invalidation. `ProfileNamespaceTombstone` and `ProfileTombstone` record permanent
loss separately from transient expiry. See [Profile Namespace Feed](../design/profile-namespace-feed.md)
and [account/profile separation](../design/account-profile-separation.md).

## Sessions and administration

### SessionToken

Each device login has one opaque `randomBytes(32)` credential. Only its SHA-256
hash is stored; login returns the plaintext as `session_token`. API and media
requests validate the same credential.

All client kinds (`app`, `web`, `desktop`) use a required, non-null sliding
`expiresAt`. `client` is informational and does not grant permanent sessions.
`autoTerminateDays` is initialized from the account's inactivity preference
(default 30 days). Activity updates `lastSeenAt` / `lastSeenIp` and extends the
deadline through a throttled touch. The old `trusted` and `persistent` columns
are not present. See [session-token.service.ts](../../src/auth/session-token.service.ts)
and [session-policy.ts](../../src/auth/session-policy.ts).

Revocation records `revokedAt` and `revokeReason` and clears push subscription
fields atomically. `pushSubscriptionRev` starts at 1; `pushToken` is nullable
and unique across sessions. `pushPlatform`, `pushDeviceId`, `pushP256dh`,
`pushAuth`, and `pushRegisteredAt` describe the current registration. A check
constraint prevents a partial subscription shape. Confirmed permanent provider
failures clear the exact captured token/revision and increment the revision;
HELLO and session-targeted SSE let clients recover it.

`LoginCode` stores hashed, expiring, single-use administrator-issued login codes.
`UserPreference` stores account-owned JSON preferences and their revisions.

### Administrative state

- `Admin` links an administrative role to `Account.id`; it does not own a
  second user namespace.
- `AdminSession` stores a separate opaque administrative credential.
- `WebAuthnCredential`, `AdminLoginChallenge`, and `TwoFactorBackupCode` retain
  passkey/challenge/recovery state. TOTP state belongs to `Admin`.
- `AdminActionLog` records `STARTED`, `SUCCEEDED`, and `FAILED` outcomes for
  audited actions. A stranded `STARTED` entry has an unknown outcome.
- `SystemSetting` stores operator configuration, not application-owned private keys.
- `DiagnosticsReport` indexes support bundles under `data/diagnostics/`.

## Relationships, groups, and local conversation state

### RelationshipIntent and RelationshipPair

`RelationshipIntent` is a directed fact keyed by author and receiver account
and namespace coordinates. Each direction has its own status, note,
`requestedAt`, `expiresAt`, and exact profile reference. `REQUESTED` is effective
only before its absolute expiry, at most seven days after the request time.
`ACCEPTED` and `REVOKED` have no expiry.

`RelationshipPair` folds the two directions under the canonical pair lock. It
owns the source-correct endpoints, relationship kind, optional thread binding,
and `active` / `established` state. A retained endpoint or thread is not an
independent authorization grant. There is no polymorphic `Invite` table and no
`ThreadMember` table. See the [relationship state machine](./relationship-intent-state-machine.md)
for transition and authorization details.

`GroupRequestProjection` is a shared request-list projection for member-authored
applications and group-authored invitations. It is not membership authority.
Managers consume separate application/invitation number streams.

### MessageThread and AccountThreadState

`MessageThread` owns local message and deletion coordinate spaces (`curSeq`,
`tombstoneEndSeq`), the inclusive history-clear boundary (`clearedSeq`), and
federation authority/version/authorization epochs. `FederationThreadSyncState`
is the current per-source synchronization progress; `pullUntil` is not a
replacement for that model.

`AccountThreadState`, keyed by `(accountId, threadId)`, stores one local
account's conversation projection: role, conversation/visibility state, read
position, exact unread count, mention position, bounded preview references,
published content ends, `threadFeedId`, mute/block/pin/alias state, announcement
read position, and manager request/read heads. A remote P2P thread normally has
one local row; a local P2P has two. Group roster authority is not inferred from
these rows.

### GroupMeta and GroupMetaMemberFeed

`GroupMeta` is keyed by `threadId`. It holds the origin allocation end or the
mirror's completed-round coordinate (`metaEndId`), selected group-profile
revision, and group request allocators. `metaTargetId`, `metaProcessedThroughId`, and
`metaRecoveryThroughId` retain independent mirror synchronization progress.

`GroupMetaMemberFeed` stores one current operation per stable key, including
member upsert/departure and the group-wide projections. It is used for both
canonical origin state and validated mirror replicas; there is no separate
physical `GroupMetaProfileFeed`. A member departure retains its final reference
but does not request a profile fetch. Announcements use the same fact rows:
`{ text: null }` means an explicit clear, while an absent row means unknown.
All facts share `createdAt`, `updatedAt`, and nullable `originCreatedAt`; no
announcement-specific time columns exist.

`ThreadAudience` is the origin's current federation delivery/visibility
projection, including history and Group Meta floors. A remote-group mirror has
no independent audience for republishing origin facts. See [canonical Group
Meta](../design/canonical-group-meta.md) and [consumer rounds](../design/federation-consumer-rounds.md).

## Client feeds

`ClientStateFeed` is an append-only per-account feed whose rows carry one complete incoming-request
head body `{ requestEndId, requestReadId }`; it persists the account-wide incoming-request read
watermark, so request read state is not exclusively per-device.

Conversation snapshots, content heads, unread counts, and previews use
`AccountThreadState.threadFeedId` and the independent `POST /thread-feed`
cursor. HELLO advertises both heads; `STATE_FEED_UPDATED` and
`THREAD_FEED_UPDATED` wake the appropriate drain. SSE is not durable history.
There are no separate device message or tombstone feed tables. See [thread
feed](../design/thread-feed.md) and the [API reference](../api/api.md).

## Messages, deletion, and media

### Message and deletion facts

`Message.id` is an internal BigInt surrogate. `(threadId, seq)` is the local
message identity exposed to clients. Federated deduplication additionally uses
`(threadId, publisherNamespaceId, originSeq)`. The author snapshot is independent
of that source coordinate: `creatorAccount`, `profileNamespaceId`, and
`profileRev` select the author reference. `payloadDigest` binds the wire payload;
`localState` distinguishes `READY`, `STUB`, and `CONFIRMED` materialization.

The stored content-type enum includes `PURE_TEXT`, `INVITE`, `IMAGE`, `VIDEO`,
`FILE`, `AUDIO`, `LINK`, `FORWARD`, `GALLERY`, `CONTACT_CARD`, and `SYSTEM`.
Storage enum membership does not make every type sendable or federatable.
Client-only `TOMB` responses are not a stored content type.

`DeletedMessage` is the local deletion-coordinate log.
`FederatedMessageTombstone` retains source deletion facts for convergence even
when their target message has not arrived. `MessageReport` is keyed by
`(threadId, seq)` and has a message foreign key; dismissal is independent of
message deletion. See [message deletion](../design/message-deletion.md).

### CAS and transfer state

- `MediaAsset` indexes verified SHA-256-addressed blobs under
  `data/cas/<dd>/<dd>/<digest>`; liveness derives from reachability, not refcounts.
- `MessageAsset` binds digests to messages for exact-object authorization.
- Outbound `PendingMedia` retains the pre-message send intent and idempotency
  key. Inbound `PendingMedia` instead references an existing staged `Message`
  through `messageId`, with its captured publisher/authorization epoch. The
  direction-shape constraint forbids mixing the two representations.
- Inbound batch states include `pending`, `downloading`, `ready`, and `failed`.
  Retained terminal jobs support retry and administration; an inbound media
  message may already have a timeline `STUB` before its bytes are ready.
- `FileSyncProgress` tracks per-file transfer work; `UploadSession` owns
  sequential resumable client uploads.

See [atomic rounds and history gaps](../design/federation-atomic-rounds-and-history-gaps.md),
[media status](../design/cas-media-download-status.md), and
[transfer administration](../design/media-transfer-management.md).

### Forward bundles

`ForwardBundle.id` is an auto-incrementing PostgreSQL `bigint`; message,
dependency, and asset associations use matching bigint foreign keys. Application
code retains these keys as native `bigint`, never JavaScript `number`.
`ForwardBundle.messages` is an immutable JSONB array. Private nested bundle
references in that array use exact positive decimal strings because JSON cannot
encode native bigint. Relational reads fetch bigint keys as native columns,
not JSON aggregate numbers; closure construction reads the graph in one
read-only repeatable-read snapshot.

The local root ID maps to the SHA-256 content identity in `sourceBundleId`.
Timeline cards retain this stable digest at creation and import; client and
federation reads never expose the local root ID. Closure construction rewrites
private nested references to wire digests. Imported child IDs remain scoped to
their enclosing closure rather than becoming global source identities.
`ForwardMessage` binds the timeline card to its root;
`ForwardBundleDependency` indexes nested child closure, and
`ForwardBundleAsset` binds closure assets. Inner messages retain display-only
profile snapshots, not author account/domain/root-key objects. Bundle-local IDs
and display snapshots never replace outer message authorization.

`CallHistory` journals local call observations and projects the first terminal
observation to a device-only SYSTEM notice; `messageSeq` records completed
projection. See [local call history](../design/local-call-history.md).

## Federation and execution

`IdentityNamespace` is the peer identity/lifecycle aggregate, including route
domain, pinned identity evidence, recognition, availability, quotas, and health
state. Namespace `0` is the local identity. `S2SKeyCache` caches certified signing
keys. `LocalFederationRoot`, `LocalFederationSigningKey`, and
`LocalFederationSigningState` own local key lifecycle;
`FederationIdentityReview` retains administrator review state.

`PeerStateFeed` stores compacted per-peer directional facts and content heads.
`FederationThreadSyncState` retains independent forward targets/progress;
`FederationThreadHistoryGap` retains recoverable reverse-history intervals.
Group Meta synchronization has its own group-scoped progress, rather than
running as a nested durable task for each state item.

`DurableTask` is generic operational history, not relationship or roster
authority. `kind`, `scopeType`, and `scopeKey` establish execution lanes, with at
most one `PROCESSING` row for a `(kind, scopeKey)`. Immutable claimed payloads,
checkpoints, coalescing keys, terminal results, and `SUPERSEDED` state support
bounded resumable domain work. See [durable task scheduling](../design/durable-task-scheduling.md).

Daily quota tables separate federation namespaces from local accounts and key
usage by UTC day and category. `QuotaDailyUsage`, `QuotaFileByteUsage`, and
`QuotaDailyAllowance` have corresponding `UserQuota*` tables; local overrides
live in `UserQuotaPolicy`, peer overrides on `IdentityNamespace`. Admission uses
DB-atomic counters; the in-memory breaker is a cache. See [quota enforcement](../design/quota-enforcement.md).

## Schema evolution and coordinate safety

The current SQL baseline is [0000_base.sql](../../database/migrations/0000_base.sql).
References in older plans to separate cutover migrations are historical, not
commands to run absent files. Deployed changes must use new migrations and keep
the typed schema in sync.

Internal BigInts serialize to strings through the global serialization layer.
Client message/deletion and thread-feed coordinates are int32 in the current
schema; the federation wire's broader integer and DecimalString contracts are
separate constraints. A local storage representation never changes the meaning
of a protocol coordinate.
