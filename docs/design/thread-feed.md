# Unified Thread Feed

The backend unified feed, differential counts, database preview references, and
client tomb storage/query contract are implemented.

The backend exposes `/thread/feed-delta` and `THREAD_FEED_UPDATED`. The old
notification query route and split content-head writer are removed. Mentions,
counts, preview references, and content heads share the existing fanout/read
writer. State feed still carries relationships and other non-content events.

## Database and client storage

One `AccountThreadState` row per account/thread is the compacted feed. There is
no append-only thread-feed table. The row stores a bounded previewSeqs array.

| Existing field or index                           | Target                                                               |
| ------------------------------------------------- | -------------------------------------------------------------------- |
| `Account.attentionFeedEndId`                      | `threadFeedEndId`, nonnegative integer, default 0                    |
| `AccountThreadState.attentionFeedId`              | `threadFeedId`, positive integer for published rows                  |
| Content-head JSON `messageEndSeq`                 | `AccountThreadState.messageEndSeq`, nonnegative integer, default 0   |
| Content-head JSON `tombstoneEndSeq`               | `AccountThreadState.tombstoneEndSeq`, nonnegative integer, default 0 |
| Unique `(accountId, attentionFeedId)` index       | Unique `(accountId, threadFeedId)` index                             |
| `unreadCount`, `lastReadSeq`, `lastMentionSeq`    | Unchanged                                                            |
| Web `attentionStates` / native `attention_states` | `threadStates` / `thread_states`                                     |
| Local `attentionFeedCursor`                       | `threadFeedCursor`                                                   |

Local rows hold the complete server snapshot plus independent `localReadSeq`,
not submission state. All feed/sequence coordinates remain int32. Allocation
must hold the account lock through commit: a later committed ID cannot hide an
earlier uncommitted update. Multiple accounts use deterministic lock ordering.

Remove `THREAD_CONTENT_HEAD` rows, the event type, its key/JSON writer, and
event-specific database constraint branches. Keep all other state constraints.
Add a new migration; never rewrite deployed migrations. Rebuild versioned client
caches, without old-cache imports, runtime fallbacks, or dual writes.

## Transaction and publication boundaries

- Source message/tombstone transactions store facts and admit the single content
  task. They do not update recipient counts or published content heads.
- Preview references commit with fanout projections. Read projections leave them unchanged.
  There is no cache barrier.
  Fanout remains durable, checkpointed, and yieldable.
- Fanout advances content-head columns, interval counts, the mention pointer, and the same thread
  feed ID atomically with its checkpoint. Resolve against locked current state,
  never overwrite concurrent count/read changes with an earlier snapshot. Head changes are monotonic;
  no-op retries allocate nothing.
- The synchronous read-position business command resolves the mention pointer and
  signed count delta with the read position in one transaction, allocating from
  the same account feed. Count intervals stop at the published message end and
  include tomb slots.
- Own messages and retractions of already-read messages publish changed heads
  even when unread count is unchanged. Do not gate publication on count changes.
- Visibility/relationship boundaries stay in their existing source transactions;
  this merge does not move them into fanout.
- Content fanout skips blocked accounts. Check `blocked` in the transactional
  head update, not only in an earlier audience snapshot or notification filter.
  Skipped accounts still count toward the batch checkpoint. Block state events
  themselves continue to use the independent state feed.

A source transaction may publish a new count with previously published heads.
Fanout subsequently publishes advanced heads with another ID. Compression may
collapse these updates, but a fast consumer can observe both. This is intentional.
Do not synthesize heads from cache contents or `MessageThread.curSeq` to bypass
the fanout barrier. Query-time previews may momentarily differ from the persisted
snapshot, under the already-approved eventual-consistency rule.

## Account/thread lifecycle

New rows start with zero count/read and empty preview references. Reestablishing
relationships initializes read at the latest boundary and leaves previews empty
inside the business transaction, using the shared read writer. Repeated activation
and profile/role updates do not reset active members. Departures and namespace
retirement do not delete preview state; later activation owns initialization.

Read advancement does not mutate preview references. New eligible messages extend
the bounded preview memory; ineligible messages, including the account's own
messages, leave it unchanged. History clearing and visibility changes may prune
references that are no longer visible. There is no startup hydration, cache
deletion, or cache queue.
Use canonical Account State / Relationship Pair / Thread Content ordering for
database mutations. A fan-out projection commits one account-thread pair per
transaction: after its parent and thread locks, it locks that account's
`Account` feed allocator before acquiring or writing `AccountThreadState`.

## HTTP and SSE contract

`POST /thread/feed-delta` uses the existing API prefix and business envelope.
It replaces attention delta and the content-head portion of state delta.

```ts
interface ThreadFeedRequest {
  after: number;
  through?: number;
  take?: number; // default 100, 1..200
  previewCount?: number; // default 0, 0..3
}
interface ThreadFeedState {
  threadId: number;
  threadFeedId: number;
  messageEndSeq: number;
  tombstoneEndSeq: number;
  groupMetaFeedEndId: string | null;
  joinRequestEndFeedId: number;
  joinRequestReadFeedId: number; // -1 disables manager-only attention
  groupInviteEndFeedId: number;
  unreadCount: number;
  lastReadSeq: number;
  lastMentionSeq: number | null;
  previews?: ThreadPreview[];
}
interface ThreadPreview {
  seq: number;
  createdAt: string;
  sender: { account: string; domain: string };
  status: 'LIVE' | 'USER_RETRACTION' | 'MODERATION_REMOVAL';
  text?: string; // live preview text only; never included for deleted entries
}
interface ThreadFeedResponse {
  threadFeedEndId: number;
  through: number;
  scannedThrough: number;
  hasMore: boolean;
  items: ThreadFeedState[];
}
```

The tombstone head is the tomb-feed coordinate, not a deleted message's seq.
Order rows by `threadFeedId`. Read allocator, rows, and pagination in one database
snapshot. Require `0 <= after <= through <= head`. Probe one extra row; when more
rows remain, `scannedThrough` is the last returned ID, otherwise it is `through`,
including empty pages. A compacted row moving beyond the fixed target is consumed
in the next drain. If the head exceeds the target, drain again without requiring
a fresh SSE signal.

The web conversation list persists the latest `threadFeedId` on every visible
thread item. Pinned items form the first tier; within the pinned and ordinary
tiers, items are ordered strictly by descending `threadFeedId`. The account-level
unique constraint makes equal IDs invalid. A structural thread-state projection
that arrives before its thread snapshot remains hidden until that positive feed
ID is available. Clients must not reconstruct list order from timestamps, local
arrival order, thread IDs, or a separately persisted order array.

Preview count zero omits the array. Otherwise return up to the requested number
of latest other-sender entries, ordered by seq ascending. Own messages never
occupy slots. Retractions retain stored slots; queries attach current deletion facts. Deleted text
is localized by the client; no original text is returned. Avatars are supplied
only by client-side profiles or the agreed logo/account fallback.

`previewSeqs` contains unique, positive thread-local message sequences in strict
descending order, bounded to three entries. It stores references only,
never copied content, authors, timestamps, or deletion status. Read advancement
and forced backwards reads leave references unchanged. A newly published eligible
message rotates the bounded set; an ineligible message does not replace it.

SSE `THREAD_FEED_UPDATED` carries `{ threadFeedEndId }`. HELLO includes both
`stateFeedEndId` and `threadFeedEndId`. Remove `ATTENTION_FEED_UPDATED` and the old
attention head field. State SSE remains independent. SSE only signals a target;
it does not transport the snapshot bodies.

After a fanout batch commits, every authorized account projection enters the SSE
channel without filtering on notification changes. Each projection also returns
`unreadCountChanged` and `previewChanged`, computed from locked transaction state.
Only results with either flag enter offline Push. Preview changes include a new
deletion within the retained preview references, even when their sequence array
and unread count are unchanged. Deleted preview entries continue to expose
`USER_RETRACTION` or `MODERATION_REMOVAL` for client localization.

Thread SSE and message Push use independent per-account throttles: one second
for SSE and five seconds for Push. Each sends the first head immediately, merges
subsequent heads by maximum without extending the window, and sends a trailing
head only when newer work arrived. Slow provider requests never overlap for the
same account. Each Push round checks current session validity and SSE ownership
for every registered device; one online device does not suppress other devices.
Call signaling and incoming-call Push do not use these message throttles.

These remain process-local, best-effort hints. Pending windows are discarded on
shutdown, and multiple server processes do not share a global account cooldown.
Feed polling recovers missed SSE hints for connected accounts; offline Push has
no durable retry guarantee. Network delivery does not gate fanout completion.

## Consumption and notifications

All consumers traverse this unified feed, including notification clients.
Persist every complete page's server snapshots and `scannedThrough` together,
retaining local optimistic positions. Feed cursor advancement means snapshot
consumption, not completion of all message-body/tombstone downloads. Persisted
heads drive those existing independent synchronization loops.

Notifications use `previewCount` on the same query and the existing signed count
merge. Process every row before advancing the cursor, including muted, blocked,
or zero-count rows. Presentation filtering cannot skip feed consumption. A locally
corrected zero count removes the notification. Render from the accepted local
row, not an older response that lost the per-thread version comparison.
There is no separate partial `attentionStates` attachment and no special rule
against advancing the cursor after a complete notification-consumed feed page.

## Removal and rename inventory

### Executor migration status

- The browser database worker and Rust source executor own thread-feed HTTP
  pagination, validation, and atomic server-snapshot/cursor commits. The Angular
  `UserService.queryThreadFeed` HTTP method has been removed.
- A later request failure returns already-committed snapshots and the durable
  cursor to the renderer. No immediate retry is scheduled; a subsequent wake
  resumes from the database cursor.
- The renderer supplies its own applied thread-feed cursor. After draining, the
  executor reads snapshots newer than that cursor and the durable cursor in one
  local read transaction, including updates committed by another executor before
  this call. An already-caught-up network cursor must not produce an empty UI
  update merely because the renderer missed the earlier completion. This covers
  server thread-feed snapshots, not the planned revision stream for all local
  changes such as optimistic read positions.
- The desktop Rust SSE connection directly wakes one coalescing thread-feed
  consumer. Its completion emits `LOCAL_THREAD_FEED_COMMITTED` locally; this is
  not a new server SSE event. The renderer handles it by reading local changes,
  never by issuing another network drain. Closing the stream cancels its consumer.
- After the browser account cache opens, a transferred MessageChannel connects
  the existing SSE and DB workers. Thread wakes and local completion notices use
  this port without renderer forwarding. Pending wakes coalesce in the DB worker;
  a new HELLO rebinds the port after reconnect or worker replacement.
- Android/Kotlin direct wake admission, optimistic-count projection/read
  submission, and the local revision-based rendering handler remain to be moved.
  Notification consumers have not completed this cutover. Native HELLO bootstrap
  still explicitly drains after account-cache initialization; an earlier native
  wake may have raced fresh-login cache recreation.

### Inventory

#### Native notification cutover contract

- Every client synchronization requests the server-defined three previews through
  the same executor and snapshot/cursor transaction. Native
  drains serialize cursor ownership and recheck cache lifetime after admission.
- A notification target at or below the shared durable thread-feed cursor is
  consumed already: skip the request and notification. Do not backfill previews
  or keep a separate notification completeness cursor. Cursor commit, rather
  than successful OS presentation, is the consumption boundary; a crash between
  commit and presentation can therefore lose that reminder by design.
- The Android JNI result carries notification metadata plus deduplicated
  cached avatar bytes (`Vec<u8>` to `ByteArray`), not base64 or JSON byte arrays.
  Kotlin decodes individual sender avatars and owns OS presentation; existing
  thread deep-link navigation remains unchanged.
- Android Application now initializes the database location through JNI before
  Activity/WebView startup. Kotlin obtains the exact path from Rust; Tauri setup
  validates and reuses that location. Conflicting directories fail initialization
  rather than silently opening a second database. Pure database commands no longer
  require AppHandle. Account-cache admission and replacement still use the existing
  lifetime barrier. This initializes the location only, not a new account schema.
- Profile and binary-avatar reads have shared database helpers. Android Application
  eagerly creates the existing Rust ProxyState alongside the database location,
  restoring secure-store token and configured/active origins. Tauri clones that
  state instead of constructing another connection pool or restoring stale config
  over live background state. Kotlin token/origin setters directly update it via
  JNI, including background session expiration. Ordinary database access only reads
  the initialized location; it cannot lazily initialize runtime resources.
- Push wakes carry `{ type: 'NEW_MESSAGE', threadFeedEndId }`. Fanout reuses each
  account's queried thread-feed head for both SSE and out-of-band push; recipient
  heads are never replaced with a shared message sequence. Duplicate push targets
  retain their highest head.
- Thread-feed synchronization can run without AppHandle. The existing HTTP
  executor accepts an optional shell event sink, retaining the same connection
  pool, failover and request policy for background callers.
- Android has a background-only `synchronizeNotifications(userId, threadFeedEndId)`
  JNI boundary returning notification JSON metadata and a separate `ByteArray[]`.
  Rust consumes the common feed executor, reconciles counts against current local
  read positions using the existing slot-count query, and resolves exact cached
  profile references and deduplicated avatars. Consumed targets return no cards.
  Storage retains only the highest-sequence preview; the response's other previews
  remain transient notification input. Missing profile/avatar data does not cause
  a network fetch. Clearing/replacing an existing session token invalidates queued
  account-cache work, including background-only session expiration.
- Kotlin FCM and background THREAD_FEED_UPDATED/HELLO now use this JNI result.
  WorkManager uses the same executor with head discovery rather than a wake target.
  Pending wakes retain the greatest target; a pending scheduled poll retains head
  discovery. Returned cards are checked against the existing Rust account epoch,
  persisted session token, user ID and foreground status before presentation.
- Kotlin renders exact counts, localized retraction/moderation placeholders,
  per-sender cached avatars. Missing avatars use the app
  logo. A zero-count update cancels its thread card. Session clearing cancels all
  message cards, not only the retired summary ID. Notification clicks retain the
  existing thread deep-link route.
- The old Kotlin notification HTTP query, persisted notification-feed cursor and
  WebView cursor-mirroring bridge are removed. Native cache schema 22 rebuilds old
  account caches, including dropping notification_feed_state, without migration.
  The unused Android WebView showDescriptor bridge and its legacy renderer are
  removed. Notification taps remain in a native mailbox until the WebView opens
  the thread and acknowledges it; WebView creation does not discard the target.
  Call notifications retain their existing letter-avatar fallback. Cold-push and
  notification-tap device verification remain pending.

#### Implementation inventory

- Browser application bootstrap now requires the document-lifetime
  `soms-active-page` Web Lock. Waiting pages do not import application services or
  open account databases; closing the owner allows the next page to bootstrap.
  Native shells retain their existing instance lifecycle. Unsupported browser
  environments show an explanatory screen instead of starting without exclusivity.
  Page workers and Push workers do not acquire this document lock: they continue
  sharing the per-account feed-drain lock. Push presentation and click routing
  identify the owning window using the lock snapshot's client ID, rather than
  treating a visible waiting page as the application. This snapshot is advisory,
  not a database synchronization barrier. All validated account database opening
  paths now close and invalidate their handles on `versionchange`.
- Web Push, like native projection, needs the account identity only when counting
  a nonempty optimistic-read interval. An empty interval needs no profile and
  uses a zero correction. A nonempty interval with missing identity still fails
  explicitly rather than counting the account's own messages as unread.
- The shared Web/Rust server snapshot type is `ThreadFeedSnapshot`. Local attention
  reconciliation remains a separate concept and reuses the existing interval-count
  algorithms. Web storage uses `getThreadStates`, `mergeThreadStates`, and
  `advanceThreadRead`; native commands use `native_db_thread_states`,
  `native_db_merge_thread_states`, and `native_db_advance_thread_read`.
- `ThreadFeedHeadWriter` publishes the account-thread head columns. Client content
  heads no longer have a second state-feed writer. The backend delta route and SSE
  wake use thread-feed names without old API aliases.
- Browser and desktop presentation now consumes `threadNotifications$`, emitted
  after the existing repository count reconciliation succeeds. Ordinary sync still
  requests one preview. Cache hydration does not emit notifications. Presentation
  batches coalesce by thread; foreground updates are consumed silently, and account
  invalidation drops queued work. Browser presentation deduplication uses a rebuilt
  thread-feed checkpoint (not a synchronization cursor); desktop uses session memory.
  Zero-count browser updates close the matching card. Desktop presentation now uses
  Rust commands instead of the plugin's optional JavaScript global. Linux retains
  notification handles by thread for replacement, zero-count dismissal, and clearing
  on focus/logout; frontend commands are serialized so clear follows earlier posts.
  Posting shares the native account-cache lifetime. Windows uses WinRT directly,
  with the configured application ID, a fixed message group, and thread-ID tags.
  Reposting replaces the thread toast; zero-count updates remove its history entry,
  and session cleanup removes the message group, including entries from a previous
  process. macOS uses UserNotifications with stable thread identifiers, individual
  sender-independent message cards, and prefix-scoped removal of pending/delivered
  notifications. Permission authorization completes outside the account lifetime
  guard; delivery then rechecks the captured task epoch. The native delegate shares
  the existing pending-thread navigation path. The old Tauri notification plugin,
  its initialization and capability are removed. Linux stores message notification
  IDs by thread in the existing device-preference store, qualified by the D-Bus
  instance GUID and notification service's unique owner. Matching records survive
  application restart; a changed daemon discards old IDs without closing them.
  Closure addresses the unique owner, never a replacement service. Updates close
  the tracked card before posting its replacement rather than passing an old ID
  to a potentially restarted daemon. Failed closure remains recorded for later
  cleanup. OS display and local persistence cannot commit atomically: a crash after
  display but before recording its ID can leave an untracked notification. Linux
  body clicks focus the main window and retain a
  pending thread ID in Rust. The page subscribes before reading that
  pending tap, uses its existing navigator, and acknowledges only after navigation
  is accepted. Notifications and pending tap records carry no account epoch.
  Actual password/OTP/QR login clears message notifications and pending taps before
  publishing the new logged-in state; logout also clears them. Ordinary cold-start
  session restoration preserves notifications and pending navigation. Task execution
  retains its epoch checks. Already-delivered click races are accepted; cleanup
  failures are logged.
  Windows toasts use protocol activation with `soms-notification://thread/<id>`.
  The Windows-only installer configuration registers that scheme. Tauri's deep-link
  plugin and the existing single-instance plugin route both startup URLs and later
  activations into the same pending-thread path. Only a canonical positive int32
  thread ID on that exact route is accepted. No runtime registry registration is
  performed; development/portable binaries need an installed protocol association.
  macOS delegate timing during OS cold activation, Windows installation/AUMID behavior and all
  OS notification interactions still require platform verification. Browser page and Push presentation share the existing
  cached-avatar data-URL conversion: use the conversation's exact cached avatar
  path (contact or group), otherwise the app logo. Notification construction never
  fetches an avatar. Desktop icons still use the native default.
- The backend `/notification-feed/query` route, unused backend descriptor model,
  and browser/desktop `NotificationFeedService` are removed. The Web Push Service
  Worker now uses the same thread-feed drain and local interval-count reconciliation.
  Generated declarations for both retired notification routes have been removed.
  No independent notification query or state-feed notification cursor remains.
- Message notification action routes, DTOs, services, button models, renderer loops
  and reply dispatchers are removed. Body taps retain thread navigation. Android
  retains only call controls in its broadcast receiver; Web Push retains public
  VAPID configuration.
- Browser storage is shared through `WebdbStorage`; `WebdbService` only supplies
  Angular injection and the page's database-worker factory. The database worker
  uses the shared class directly without constructing another worker. Existing
  schema and count algorithms are shared. Background execution opens only existing
  account caches, using the persisted account selection. IndexedDB version changes
  close background handles and invalidate late writes. Feed drains share a per-account
  Web Lock; Push execution requires Web Locks rather than running unsynchronized.
  In-memory account epochs are not shared between contexts.
- Push requests three previews and persists only the newest one. Presentation uses
  current local read progress and the transient preview batch. Already-consumed
  targets do not fetch or post again, and do not consume pending page presentation.
  Completed background writes send a validated COMMITTED wake to the page, which
  refreshes from its database. Body taps send OPEN; there are no action requests.
- The Push worker is bundled by `web/scripts/build-push-worker.mjs`, including its
  dedicated TypeScript check. Fixed script paths use `updateViaCache: 'none'` and
  Caddy `no-cache` routes without SPA fallback. Hashed static assets retain immutable
  caching. Closed-page Push delivery and live worker-upgrade verification are pending.
- Remove remaining readRevision/read-delta consumers and direct count-overwrite
  paths. Do not add pending-read state or confirmation-driven cancellation.

## Review gates

1. Review this contract and the [database schema](../../src/database/schema.ts).
2. Implement a new migration, shared allocator/head writer, backend delta/SSE,
   and transaction/fanout tests. Stop for review.
3. Cut over Web/native/Android schemas, drains, interval-count reconciliation, and
   notifications. Rebuild caches and remove old consumers. Stop for review.
4. Verify own-message and read-message retraction wakes, concurrent count/head
   updates, pagination, database-preview recovery, and two-browser convergence.
   Do not deploy mixed old/new contracts.

## Directed departure projection

A departure SYSTEM message atomically admits ordinary local fanout and a separate
`FAN_OUT_ACCOUNT_THREAD_CONTENT` task for each departing local account (both local
endpoints for P2P). Directed tasks have independent account/thread scopes and are
never merged into, replaced by, or yielded to ordinary pending fanout.

Execution acquires the shared parent/thread locks, requires a retained established
relationship, and uses the common message visibility lookup. Missing threads,
missing relationships, cleared/invisible messages, and already-covered message
heads complete without another projection. Otherwise the common head writer commits
the projection with its task checkpoint; existing SSE/Push publication runs afterward.
Notifications remain recoverable hints, with the committed thread feed owning delivery.

P2P and group revocation preserve the client's historical thread as read-only. The
client relationship feed carries the monotonic establishment fact so this behavior
also holds on a device that never saw the original activation.

## Private conversation aliases

`AccountThreadState.alias` is a required nullable field in every thread-feed
snapshot. A changed alias allocates a thread feed ID in the same transaction;
identical submissions allocate nothing. `/thread/set-alias` returns the committed
`{ threadId, threadFeedId, alias }` and publishes `THREAD_FEED_UPDATED` only after
commit, only to the editing account. Whitespace-only labels become `null`.

An editor keeps its draft private until a successful HTTP response. Writes are
serialized per account session and thread; queued writes from expired sessions are
discarded. Both that
response and committed worker/native feed snapshots publish the local
`THREAD_ALIAS_APPLIED` event. The Angular repository compares per-thread feed IDs,
so duplicate events and late responses cannot overwrite a newer confirmed label.
Acknowledgements never advance the local feed cursor or fabricate full snapshots.

The complete feed snapshot owns durable aliases. Conversation records are
structural projections; reading them joins the alias from thread state. Rebuilding
or refreshing a relationship cannot overwrite that label. Browser and native cache
versions are bumped and old cache data is rebuilt, without importing old labels.

Online and offline notification titles use the delivered thread snapshot's alias,
independently of structural-cache writes. An empty alias falls back to the selected
profile name, then the normal account fallback. Metadata-only feed changes update
names without alerting again for existing unread messages. List ordering continues
to use the unified thread feed ID, including revisions allocated by alias edits.
