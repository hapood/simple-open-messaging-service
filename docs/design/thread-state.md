# Account-owned thread state

`THREAD_STATE` is a complete compacted client state-feed snapshot keyed by the
local account and thread ID. It replaces `THREAD_BLOCK`. Relationship intents
continue to drive request UI, but clients do not fold them into conversations.

The snapshot contains the thread type and authority namespace, `ACTIVE` or
`READ_ONLY` lifecycle, establishment time, blocking flag, local group role, and
an exact default profile reference (`account`, `domain`, `namespaceId`,
`profileRev`). Profile bytes are resolved separately.

## Publication and retention

The relationship-establishment transaction publishes the snapshot for each
local participant. Participant insertion and block/role changes also refresh
it from authoritative facts. A request shell without an established pair does
not publish a snapshot. PostgreSQL triggers centralize these writes so local,
federated, and forced-revocation paths obey the same atomic contract.

The profile reference is copied from the opposite authored intent when the
relationship becomes active. Ordinary profile updates, blocking, and revocation
do not change it. Re-establishing a retained relationship refreshes the reference
and establishment time. A duplicate activation does neither. Revocation retains
the snapshot and default profile reference with `READ_ONLY` state.

The migration backfills established conversations, including empty and retained
read-only conversations, and removes old `THREAD_BLOCK` snapshots. Full state
queries include unblocked conversations. Existing state-feed wakes remain in
use. Business transactions capture the state and thread heads affected by
conversation changes, then publish them through the existing SSE notification
methods and per-account throttles after commit. Read-position tasks also publish
their thread head after commit. There is no periodic head query or database
notification listener for these feeds; SSE reconnects recover via `HELLO`.

## Independent feed consumption

The thread feed owns message coordinates, previews, read positions and counts.
The client state feed owns conversation identity and visibility. Their cursors
are independent.

If the thread feed arrives first, its atomic page commit saves the attention
snapshot and an invisible `PENDING` thread-list record. `THREAD_STATE` promotes
that record to a visible conversation without overwriting attention data. If
state arrives first, later thread feed pages preserve the established identity.
Browser IndexedDB and native SQLite implement the same ordering contract.

New or re-established conversations are ordered by server establishment time
alongside message activity, within the existing pin tiers. Block updates and
replays do not promote an existing conversation. Read-only and re-establishment
snapshots preserve the cached group roster and its cursor; membership data continues
to follow the independent group-meta feed. If its cursor is unavailable, the client
clears that roster and resets its cursor before requesting full pages. A failed
rebuild leaves the reset cursor ready for the next full attempt. Full recovery hides old rows
until their authoritative snapshots are replayed. Renderer writes cannot
replace a newer persisted state-feed snapshot.

## Exact default profile resolution

Clients call the existing profile-resolution endpoint with:

```ts
{ type: 'EXACT', account, domain, rev }
```

The endpoint authorizes the exact reference against a matching `THREAD_STATE`
owned by the authenticated account. The stored namespace must match the
resolved namespace. Active request grants remain available for request UI;
message and group-member selectors retain their own authorization rules.
Authorization precedes both memory-cache and durable-profile lookup.

There is no thread-default selector or extra frontend scheduler context.
Different exact revisions naturally have different in-flight keys. Clients
check the current identity, revision, namespace and session before applying a
completion. A message-selected P2P profile is not overwritten by the default.

A zero revision is a placeholder and causes no profile request. A revoked
conversation may read a locally retained profile. If it was never cached and
the peer no longer discloses it, the client retains its placeholder; local
state does not override federation disclosure policy. Federation HTTP endpoints
are unchanged.

Implementation: [migration](../../database/migrations/0000_base.sql),
[selectors](../../shared/profile-selector.ts),
[profile authorization](../../src/federation/profile-resolution-coordinator.service.ts),
[browser projection](../../web/src/app/services/thread-state-projection.ts),
[native projection](../../src-tauri/src/native_db/client_state.rs).
