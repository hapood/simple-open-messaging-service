# Profile Namespace Feed

## 1. Purpose

A client renders a message author's domain by joining the message's profile
reference — `(publisherNamespaceId, profileNamespaceId, account, profileRev)` —
with a name-resolution cache. That cache has no expiry path today: when a
federated identity's root certificate or domain binding changes, every holder
of previously resolved namespace info keeps a stale domain until an incidental
refresh replaces it.

The Profile Namespace Feed closes that loop:

- every server publishes one compact feed of the identity modifications it
  commits (root-certificate and domain changes bound to a stable namespace),
- peers pull that feed and expire exactly the cached rows whose namespace
  matched, then re-resolve through a dedicated federation pull interface,
- clients receive the same compact entry through the client State Feed and
  invalidate their local mirror the same way.

The feed never carries authorization or routing decisions. It only invalidates
display and vouching data: domain strings and pinned root public keys used for
third-party profile verification and friend-add identity continuity.

## 2. Identity model invariants

1. **A namespace id is lifelong.** `IdentityNamespace.id` for a peer
   relationship is allocated once and never reallocated. Exactly two
   mutations exist: a **new namespace item** is added (first recognition, or
   rebuild after reset), and the **review mechanism replaces an existing
   item's** root-certificate or domain binding in place — `applyDomainRebind`
   already keeps the id, and the root-change approval changes from "insert a
   successor epoch row" to "update `rootPublicKey` on the same row". There
   is no automatic rotation. This supersedes the peer-rotation row-insert
   described in
   [`federation-root-identity-model.md`](./federation-root-identity-model.md);
   reset remains the only operation that retires a namespace id, and
   re-recognition after a reset allocates a fresh id.
2. **Certificate and domain are mutable bindings on a stable nsid.** What
   expires is the resolved domain/root for an nsid, never the nsid itself.
3. **The local server's own identity change is out of scope** (deferred
   feature), and it follows the server's own identity model rather than the
   peer review flow: a root replacement appends a new `LocalFederationRoot`
   epoch and marks the predecessor unclaimable (the predecessor stays
   published until peers adopt), while a domain replacement swaps the binding
   directly. Both stay on namespace id `0` at the namespace layer, so when
   the feature lands each change publishes one feed item with
   `namespaceId` `0`, and consumers expire the cached publisher row
   (`ProfileNamespace` row with `profileNamespaceId = 0`).
4. Feed entries are publisher-scoped nsids, like every `namespaceId` on the
   wire ([`spec/v1/protocol.md`](../../spec/v1/protocol.md) Section 6.2.1).
   Because ids are stable, no per-caller translation exists or is needed.

## 3. Publisher side: the feed

### 3.1 Coordinate and storage

- `IdentityNamespace.profileNamespaceFeedEndId` (bigint, default 0) on row `0`
  is the single per-server allocator. Every committed identity modification
  increments it once.
- `ProfileNamespaceFeed` is **one shared serving table** — every peer pulls
  the same rows. Content is identical for all pullers because nsids are
  stable and carry no per-caller meaning, so no per-peer delivery projection
  exists. (`PeerStateFeed` is per-peer keyed for two load-bearing reasons
  that do not apply here: its content and authorization are pair-private —
  relationship intents must never be servable from another peer's coordinate
  space — and each peer consumes an independent per-epoch feed coordinate.)
  - key: `namespaceId` — the affected identity; the body _is_ the nsid, so
    the key carries it and no separate body column exists;
  - `feedId`: the global counter value allocated by the modification;
  - compaction: one row per affected nsid, upserted to the latest feedId.
    Two different identities changing between a peer's pulls both survive;
    a repeated change of the same identity collapses to the newest feedId,
    which is the only fact a consumer needs.
- One modification is one counter bump plus one row upsert, committed in the
  same transaction as the `IdentityNamespace` change.
- Pull progress for each peer lives on that peer's own row as
  `IdentityNamespace.profileNamespaceFeedPulledThrough` (bigint, default 0),
  mirroring how `stateFeedEndId` lives on the epoch row. The existing State
  Feed pull cursor table folds onto the same row as `stateFeedPulledThrough`
  (NULL = never bootstrapped) as part of this work, so all three feed
  coordinates share the epoch row.

### 3.2 Write points

| Trigger                                                             | Source                                                                                   | Feed body nsid         |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ---------------------- |
| New namespace item                                                  | `federation-recognition.service.ts` `acceptInbound` / `prepareOutbound` epoch activation | the newly allocated id |
| Review-approved binding replacement (root change or domain re-bind) | `federation-namespace-admin.service.ts` approval path                                    | the replaced row's id  |

A new-item entry never matches a consumer's cached row (new id) and is
recorded for uniformity only. A reset rebuild entry behaves the same; a
consumer's rows for the retired id are dead state after the reset.

## 4. Protocol additions

All shapes are closed; unknown fields are rejected. The protocol is unreleased,
so no backward compatibility is maintained for any change in this document.

### 4.1 Counter disclosure (State Feed)

Recognize is unchanged — it carries no Profile Namespace Feed field. The
per-server counter is disclosed through the State Feed channel:

- the `GET /s2s/v1/state-feed` page response envelope gains
  `profileNamespaceFeedEndId` (decimal string) alongside `stateFeedEndId`;
- a consumer compares it against its
  `profileNamespaceFeedPulledThrough` for the publisher and
  schedules a Profile Namespace Feed pull when behind;
- cold start needs no disclosure: the first pull omits `after` (sender-side
  zero fallback), and the recognition commit schedules one initial pull.

### 4.2 Feed head push

`POST /s2s/v1/feed-heads` carries one merged, closed body:

```ts
interface FeedHeadsPush {
  stateFeedEndId: string; // unsigned decimal string, required
  profileNamespaceFeedEndId: string; // unsigned decimal string, required
}
```

Both fields are always present; the key set is closed. Each field is
handled independently: `stateFeedEndId` wakes the State
Feed pull exactly as today; a `profileNamespaceFeedEndId` ahead of the
receiver's Profile Namespace Feed cursor for the signer wakes that pull.
Push scheduling reuses the per-peer coalescing scheduler pattern of
`federation-state-feed-push-scheduler.service.ts` with the feed dimension as
a second key.

### 4.3 Feed pull

`GET /s2s/v1/profile-namespace-feed?after=&take=&through=` (recognized
signed):

- serves the shared compacted rows with `feedId > after`, ordered
  ascending, page-bounded by `STATE_FEED_PAGE_MAX_BYTES`;
- `after` is optional and the **sender performs the zero fallback**: an
  omitted `after` serves all compacted rows from `0` together with the
  current `feedEndId`, so a first-time puller initializes its cursor directly
  from the response — there is no cursor-unavailable envelope and no
  receiver-side bootstrap for this feed. An `after` greater than
  `feedEndId` is malformed;
- response page: `{ items: [{ namespaceId, feedId }], scannedThrough,
feedEndId, hasMore }` with decimal-string feed ids.

### 4.4 Namespace bindings pull

`GET /s2s/v1/profile-namespaces/:nsid` (recognized signed):

- resolves exactly one nsid _in the responder's own namespace space_;
  identity selection follows the s2s path-parameter convention of
  `account-profiles/:namespaceId/...` — query parameters are reserved for
  cursors and pagination;
- `nsid = 0` returns the responder's own current bindings
  `{ domain, rootPublicKey, status, profileNamespaceFeedEndId }` with
  `status = ACTIVE`;
- a positive nsid returns the identity currently bound there; a
  reset-retired id keeps answering with its last retained bindings
  disclosed as `status = ARCHIVED` so historical references stay renderable
  and the puller caches the lifecycle, and only an id that never completed
  a handshake is a miss;
- one request per nsid matches the per-`(publisher, nsid)` refresh scheduler
  granularity, so no batch form exists;
- the answer is display/vouching data only; it never mutates the requester's
  trust pins.

## 5. Consumer side (server)

### 5.1 Cache table

`ProfileNamespace`:

| Column                    | Meaning                                                                                               |
| ------------------------- | ----------------------------------------------------------------------------------------------------- |
| `publisherNamespaceId`    | our local id for the publisher whose space the row lives in                                           |
| `profileNamespaceId`      | the identity's nsid in that publisher's space (`0` = the publisher itself)                            |
| `domain`, `rootPublicKey` | the _subject identity's_ current bindings — for `profileNamespaceId = 0` these describe the publisher |
| `updateFeedId`            | the publisher's feed counter at fetch time; expiry compares against it                                |
| `expired`                 | `true` after a matched feed entry until re-resolution commits                                         |
| `status`                  | lifecycle: `ACTIVE` (in use) or `ARCHIVED` (reset-retired, last bindings retained for rendering)      |

`status` is orthogonal to `expired`: `expired` is a transient freshness
flag while a refresh converges, `status` is the permanent lifecycle of the
bound namespace. A reset-retired nsid keeps `status = ARCHIVED` and its last
bindings so historical references stay renderable; `UNRECOVERABLE` (permanent
loss) is not a `status` value — it is a federation error code that writes a
row in the sparse `ProfileNamespaceTombstone` table instead. The companion
`ProfileTombstone` table records the analogous permanent loss of a profile
(keyed without `profileRev`, so one tomb spans every revision).

A row always describes the identity referenced by `profileNamespaceId` in
`publisherNamespaceId`'s space. This covers both shapes clients need:
`(our-id-for-B, 0)` → B's own domain/root, and `(our-id-for-B, B's-id-for-C)`
→ C's domain/root as vouched by B.

### 5.2 Fill paths

1. **Handshake seed.** The recognition commit that activates a peer epoch also
   inserts `(newId, 0)` with the domain we hostname-verified during discovery,
   the verified root, `updateFeedId = 0`, `expired = false`, and
   `status = ACTIVE`; the first feed pull refreshes the counter. Timestamps
   reuse `createdAt` / `updatedAt` — no additional clock columns exist in any
   new table.
2. **Demand fill.** A client resolution request routes on the publisher:
   `publisherNamespaceId = 0` is this server's own namespace space and
   always answers synchronously — `(0, 0)` from the keypair snapshot (the
   real domain and current claimable root, never the `'local'` sentinel), a
   positive nsid from our authoritative `IdentityNamespace` registry — so
   these pairs can never be PENDING and never trigger a remote call. Any
   other publisher answers the ProfileNamespace cache; an unknown pair
   inserts a tomb row (`expired = true`, null bindings) and schedules a
   `profile-namespaces/:nsid` pull against that publisher. A
   `profileNamespaceId = 0` pull converges from our own registry row (the
   peer epoch we hostname-verified) without a remote call, and a
   reset-retired publisher converges its self-row to `status = ARCHIVED`
   with the retained bindings.
3. **Expiry refresh.** See 5.4.

The refresh scheduler is avatar-request-shaped: per `(publisher, nsid)`
coalescing, in-flight deduplication, retry classification, no business locks.

### 5.3 Feed pull scheduling

- Pull progress is the `profileNamespaceFeedPulledThrough` column on the
  peer's `IdentityNamespace` row — no separate cursor table exists.
- `ProfileNamespaceFeedPullService` mirrors `peer-state-feed-pull.service.ts`:
  fixed-through drain loops, per-item transactions advancing the column,
  advisory-lock single-flight; first-time pulls simply omit `after` (the
  sender-side zero fallback).
- Wake sources: the feed-heads `profileNamespaceFeedEndId` field, the
  State Feed page-envelope observation during ordinary pulls, the initial
  pull scheduled by recognition, and our own approval commits (which advance
  our _outbound_ feed and our clients' notifications, not this column).

### 5.4 Expiry closure and the client change feed

For each pulled entry `(namespaceId, feedId)`:

1. select `ProfileNamespace` rows where
   `publisherNamespaceId = our-id-for-the-publisher` and
   `profileNamespaceId = namespaceId` and `updateFeedId < feedId`;
2. mark them `expired` — an expired row is its own tomb while the refresh is
   in flight;
3. in the same transaction, upsert one row in the local
   `ProfileNamespaceChangeFeed` (see below) for the touched pair;
4. after commit, broadcast the wake (SSE `PROFILE_NAMESPACE_UPDATED`) and
   schedule the namespace-info refresh; if the returned bindings carry a
   counter behind the triggering feedId, the response is discarded and the
   fetch repeats — data older than the trigger never persists. On success the
   row is rewritten with the new bindings and `expired = false`.

For **our own approvals** (we changed a peer's bindings), the same change-feed
upsert fires from the approval transaction, and `(our-id-for-peer, 0)` rows
are refreshed from our own `IdentityNamespace` row — our pin is
authoritative — while third-party rows `(our-id-for-B, B's-id-for-C)` wait
for B's feed, which B bumps with its own approval. A converged
`refreshDirectRow` also records a change entry, because the drain that
scheduled it already expired client copies.

#### The client change feed

The s2s Profile Namespace Feed is publisher-scoped: it carries OUR namespace
binding changes for peers. Peer-learned changes update `ProfileNamespace`
only, so devices need a separate merged changelog spanning both sources.
`ProfileNamespaceChangeFeed` is that changelog: one compacted row per pair
(primarily keyed, `changeId` globally unique) plus the single-row
`ProfileNamespaceChangeFeedHead` allocator, both written inside the same
transaction as the binding change (the head row is a terminal lock, mirroring
the serving feed's row-0 discipline). Items carry no binding data — a device
that has pulled the feed but not yet resolved a pair holds a tomb and
converges through `profile-namespaces/resolve`.

Client-facing surfaces (`GET /user/profile-namespace-feed`, the HELLO
`profileNamespaceChangeEndId` anchor, the SSE wake, and the resolve entries'
`updateFeedId`) use JSON numbers with a safe-integer guard; the s2s wire
keeps `DecimalString`.

### 5.5 Client resolution endpoint

`POST /profile-namespaces/resolve` (authenticated client route): a single
`(publisherNamespaceId, profileNamespaceId)` pair resolves to either
`{ status: 'READY', entry: { domain, rootPublicKey, updateFeedId, expired,
status } }` or `{ status: 'PENDING' }`. One request per pair mirrors
profile resolution and the per-`(publisher, nsid)` refresh scheduler
granularity. `publisherNamespaceId` selects the federation peer against
which a pass-through `profile-namespaces/:nsid` pull is scheduled — without
it the server cannot know which publisher's namespace space to query. Direct
rows (`profileNamespaceId = 0`) always answer READY synchronously from
`IdentityNamespace`. Third-party rows answer READY with the cached value
(including an expired placeholder) when present, and answer PENDING when
absent — a tomb is planted and a background refresh scheduled; the client
waits for an SSE wake with a 30-second re-request timeout. A federated peer
reporting permanent loss of a resource answers with the
`FEDERATION_NAMESPACE_UNRECOVERABLE` (or `FEDERATION_PROFILE_UNRECOVERABLE`)
business code (HTTP 200); the client writes a row in the matching
`ProfileNamespaceTombstone` / `ProfileTombstone` store so the UI renders
"gone". These error codes are reserved for extreme data-loss scenarios and
are not triggered by the current server implementation.

### 5.6 Friend-add root continuity

The namespace id is the durable identity key; a domain is a first-contact
entry hint and a delivery address. A caller with prior knowledge (a contact
card or roster reference carries the nsid) addresses the peer BY ID: the
intent follows the row's current domain binding across a review-approved
re-bind, and only a reset retirement — the identity the caller knew no longer
exists — is an `IDENTITY_MISMATCH` rejection. First contact by address
resolves the domain's current active namespace and is never blocked.

The profile-card lookup (`GET /s2s/v1/accounts/:account`) is sealed-challenge
mandatory on the responder. The caller's key selection: address-based
resolution challenges under the current handshake pin (`PIN`); contact-card
and roster references challenge under the root key the publisher's bindings
name (`VOUCH`), proving the card's lineage end-to-end. An uncertifiable vouch
(tomb, expired, or a domain that no longer matches) is a business rejection,
never a silently weaker fetch.

## 6. Client

### 6.1 Storage

- IDB store `profileNamespaces`, key `[publisherNamespaceId,
profileNamespaceId]`, value `{ domain, rootPublicKey, updateFeedId,
changeSeq, expired, status, refreshedAt }`. `updateFeedId` is the publisher's feed
position from a resolve answer; `changeSeq` is the local change-feed
coordinate last applied to the row. `status` mirrors the server's
`ACTIVE` / `ARCHIVED` lifecycle. A null `domain` is a tomb: the feed was
pulled but the cache for that pair was not.
- IDB stores `profileNamespaceTombs` (key `[publisherNamespaceId,
profileNamespaceId]`) and `profileTombs` (key `[publisherNamespaceId,
profileNamespaceId, account]`) record federation-reported permanent loss
(the `FEDERATION_*_UNRECOVERABLE` codes). A row's presence is the tomb;
the binding content is empty. Sparse by design.
- Settings key `profileNamespaceChangeEndId` is the durable change-feed
  cursor.

### 6.2 Initialization order

Seeding happens at per-user database creation/upgrade inside
`WebdbStorage.openForUser()` — the same transaction that creates the schema
and seeds the `local/0` namespace record. The full chain is
`AuthService.restoreSession()` (APP_INITIALIZER, pre-router) →
`UserService.restoreWebdb()` → `openForUser()`, which completes strictly
before `ThreadListComponent` cache paint and the SSE HELLO. The first-login
database creation goes through the same `openForUser` path. The native build
seeds equivalently after `native_db_validate_cache` / `native_db_recreate_cache`
inside the `src-tauri` schema definitions. No network access occurs during
seeding; the durable meta value is thereafter the client's own feed cursor.

### 6.3 Resolution and rendering

`ProfileNamespaceRepository` follows `ProfileRepository`: bounded LRU, demand
deduplication, shared in-flight requests. Message rendering joins the profile
reference against the store, demands missing pairs, and falls back to the
existing `FederationNamespaceService.displayDomain` rendering while a
resolution is pending.

### 6.4 Invalidation

Wake sources: the HELLO `profileNamespaceChangeEndId` anchor (equal to the
persisted cursor — the profileRev skip pattern — means no pull at all), the
SSE `PROFILE_NAMESPACE_UPDATED` event, and a state-feed page envelope that
carries the same anchor. `pullProfileNamespaceChanges` drains
`(cursor, end]` from `GET /user/profile-namespace-feed`; every item either
expires the exact cached row or plants a tomb for an uncached pair, then one
resolve round converges the touched pairs. Matching is exact on the pair —
no column-wildcard invalidation, so nsid collisions across publisher spaces
cannot occur. The commit guard (`changeSeq` vs the round's end coordinate)
ensures a resolve answer fetched before a newer change can never resurrect
stale bindings.

## 7. Security and trust boundaries

- All feed endpoints require recognized, signed requests, like State Feed.
- Pulled namespace info updates display/vouching cache rows only. Trust pins,
  admission state, and message authentication remain governed exclusively by
  the recognition and review machinery; a pre-approval pull may refresh
  display data while the pin still gates traffic.
- `rootPublicKey` serves vouching verification and the friend-add continuity
  check; it never authorizes traffic by itself.

## 8. Implementation batches

Each batch ends at a review gate; no later batch starts before approval.

1. **Protocol and data model.** Spec updates (State Feed envelope field,
   feed-heads merged shape, `profile-namespace-feed` and
   `profile-namespaces` sections,
   schema JSONs), SQL migration (counter and pull-progress columns, shared
   serving table, cache table, `ClientStateFeed` event value), review-approval
   in-place root replacement,
   feed write path, both s2s endpoints, unit tests.
2. **Server consumer closure.** Pull cursor and pull scheduler, feed-heads
   wake, handshake seed, demand endpoint, refresh scheduler, expiry → client
   change-feed entries, friend-add continuity check; unit and federation e2e
   tests covering B-approval → A-pull → client invalidation.
3. **Client.** IDB store and seeding lifecycle, `ProfileNamespaceRepository`,
   worker event application, rendering join, friend-add UX, native schema
   sync.
4. **Hardening.** Coverage run, federation lab smoke, operational notes.

## 9. Open items

- Confirm the `ClientStateFeed` row conventions for the new event
  (`namespaceId` carries the publisher id for the FK; body carries the pair)
  against the final table shape during batch 1.
- The demand endpoint now carries the PENDING/wake channel of profile
  resolution: a miss answers PENDING (tomb planted, refresh scheduled) and
  the client waits for an SSE wake with a 30-second re-request timeout.
