# Account-owned thread state

An `AccountThreadState` row is the authoritative compacted snapshot for an
established account/thread pair. `POST /api/v1/thread-feed` returns its content
coordinates, attention state, conversation identity, lifecycle, and exact
profile reference together. The client state feed still publishes relationship
and request events, but no longer publishes `THREAD_STATE` projections.

A snapshot includes `threadId`, `threadFeedId`, `type`,
`authorityNamespaceId`, `ACTIVE` or `READ_ONLY` `conversationState`, `blocked`,
nullable group `role`, and `profile: { account, domain, namespaceId,
profileRev }`. It also carries message and tombstone heads, unread/read state,
nullable alias, group/request coordinates, `threadProfileRev`, and optionally
bounded previews. No establishment timestamp is sent: the account/thread
state row's creation time is not necessarily the time a relationship became
active, and the list orders by `threadFeedId` rather than a timestamp.

## Publication and retention

Establishment, revocation, block and role changes publish an updated thread
snapshot in the same database transaction. A request without an established
relationship publishes no thread snapshot and creates no local `PENDING`
conversation. Revocation retains the conversation and its profile reference
with a `READ_ONLY` lifecycle. Account feed IDs allocate under the account lock;
clients can replay a fixed-range feed without missing a committed update.

The P2P profile reference starts from the opposite participant's relationship
intent revision. After establishment, only an authored message from that peer
can advance the thread's avatar revision. Group avatar revisions advance only
from `GROUP_PROFILE` meta. An ordinary profile update, block, or replay cannot
advance the thread avatar. The thread state stores one `threadProfileRev`;
clients combine it with the stable profile identity when reading their lists.

This is a breaking client-cache revision: Web IndexedDB and native SQLite
recreate local storage without importing old state-feed projections. It never
deletes server conversations or messages. SSE `THREAD_FEED_UPDATED` only wakes
the client to pull pages; `HELLO.threadFeedEndId` allows reconnect recovery.

## Client consumption

The thread feed alone creates and updates local conversations, including
blocked state, role, and lifecycle. Its page and cursor commit atomically.
Local read position remains independent from the server snapshot. Up to three
previews may be used for immediate rendering and notification decisions, but
only the greatest-sequence preview is persisted per thread; an empty preview
array removes the stored preview. Missing required fields, including the
requested `previews` array, fail the page instead of advancing its cursor.
Relationship-intent events still maintain request UI projections, not the
conversation list. The group roster remains in the independent group-meta
feed, with its own cursor and reset behavior.

## Exact profile resolution

Clients resolve the thread profile via the existing `EXACT` profile selector.
The server checks the authenticated account's established relationship,
matching account/thread state revision, namespace, and profile identity before
cache lookup; separate request, message-author, and group-member grants remain.
Different revisions have different in-flight resolution keys. Clients check
the current session, identity, namespace, and revision before applying results.
A zero revision is a placeholder and triggers no profile request. Revoked
conversations may display a locally retained profile without overriding
federation disclosure policy.

Implementation: [thread feed](../../src/message/thread-feed.service.ts),
[migration](../../database/migrations/0001_unified_thread_feed.sql),
[profile authorization](../../src/federation/profile-resolution-coordinator.service.ts),
[browser projection](../../web/src/app/services/thread-state-projection.ts),
[native projection](../../src-tauri/src/native_db/attention.rs).
