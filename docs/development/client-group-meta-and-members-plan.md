# Client group metadata, member queries, and batched membership messages

Status: partially implemented. Direction recorded on 2026-11-22; updated on
2026-11-24:
- `POST /group/members` is implemented; `MemberProfileRepository.queryPage` in
  `web/` now queries `POST /group/members`.
- `ThreadFeedState` / `ThreadFeedStateDto` no longer carries
  `tombstoneEndSeq` or `groupMetaFeedEndId`.
- `applyDeltaMirrorMetaPageInTx` commits one page per transaction and
  reconciles member count once per page.
- `GROUP_JOINED` / `GROUP_LEFT` use `{ members, totalCount }` (max 5 members,
  no legacy singular `member` compatibility).
- `applyFullMirrorMetaBatchInTx` emits batched `GROUP_JOINED` on initial
  setup and diffs on subsequent full recovery.
- `system-row.component.ts` renders batched notices on a single fixed `24px`
  line with name ellipsis and preserved count/action suffix.
- Remaining: native Rust `mentions.rs` / `contacts.rs` cutover to
  `POST /group/members`, removing `group_members` from SQLite, and
  fixing/running full backend, browser, and Rust regression suites.

## 1. Scope and ownership

Keep client Group Meta full/delta synchronization, fixed-through pagination,
recovery, and atomic page/cursor commits. Remove only client membership-fact
consumption and the synchronized local roster. Keep member count, announcements,
and the group's own profile reference.

| Responsibility | Owner after this change |
| --- | --- |
| Canonical membership and authorization | Existing server domain capabilities |
| Replicated member facts and S2S Group Meta | Server mirror, unchanged in purpose |
| Current member list, search, and mention candidates | Authorized server queries |
| Member count and announcement synchronization | Client Group Meta full/delta |
| Profile resolution, cache keys, revisions, and subscriptions | Existing profile subsystem |
| Observed membership notices | Transactional server system-message writers |
| Native synchronization and asynchronous generation fencing | Shared Rust runtime |

Do not remove server member facts or replace S2S member synchronization with a
count. Do not reconstruct membership or count from system messages. Platform
adapters must not acquire their own synchronization state machines.

The earlier suggestion to replace the client feed with `POST /group/meta` was
rejected. No such snapshot endpoint is part of this plan.

### Related work

The separate [client miscellaneous state-feed plan](../design/client-misc-state-feed-dev.md)
changes resource-head delivery and scheduling. This plan changes
Group Meta payloads and roster ownership, not that scheduler's ownership.
Use the resource-head transport once it exists; do not introduce a second
chat-open scheduler or require heads to remain in Thread Feed.

Existing descriptions in [canonical Group Meta](../design/canonical-group-meta.md),
[system messages](../design/system-messages.md), and
[group announcements](../design/group-announcement.md) describe earlier/current
behavior. The changes below supersede their client-roster and full-initialization
notice rules only when implemented. The S2S specification is not changed merely
because the client contract changes.

## 2. Retained client Group Meta endpoint

Retain `GET /api/v1/user/group-meta` and its current targeting rules:

- Either `threadId`, or the complete `account` and `namespaceId` pair.
- `mode`: `full` or `delta`.
- `after`, optional `through`, and `take`, with existing validation and defaults.
- Client feed coordinates remain decimal strings.

Retain the response data envelope:

```ts
interface ClientGroupMetaPage {
  account: string;
  mode: 'full' | 'delta';
  items: ClientGroupMetaItem[];
  scannedThrough: string;
  groupMetaFeedEndId: string;
  hasMore: boolean;
}
```

Retain each item's `feedId`, `createdAt`, and `originCreatedAt`. The client-visible
operation union becomes:

```ts
type ClientGroupMetaBody =
  | {
      operation: 'GROUP_MEMBER_COUNT';
      body: { memberCount: number };
    }
  | {
      operation: 'GROUP_PROFILE';
      body: { account: string; namespaceId: number; profileRev: number };
    }
  | {
      operation: 'GROUP_ANNOUNCEMENT';
      body: { text: string | null };
    };
```

`MEMBER_UPSERT` and `MEMBER_DEPART` are no longer client-visible operations.
They remain server/S2S member facts. Do not teach the S2S parser to accept a new
operation as an incidental consequence of sharing a client TypeScript union.

### Count and coordinate invariants

- Count is a non-negative integer absolute value, applied by replacement.
- It describes the committed server roster, not locally authorized recipients,
  a partially downloaded full snapshot, or a mirror's unprocessed target.
- A complete full recovery establishes count, including an explicit zero.
- After initialization, only effective count changes publish a new count fact.
  Compare the final batch count with the last published count. An unchanged count
  allocates no count ID, writes no count fact, and admits no count-update wake.
  Profile/role refreshes and equal-size replacement of members do not publish a
  count update. A different changed client projection can independently advance
  the client head; membership notices independently advance message history.
- A count fact and the roster state it represents commit atomically with the
  required head/fanout publication.
- Use a new `GroupMeta.clientMetaEndId` exclusively for client projection IDs
  on both origins and mirrors. Never reuse S2S IDs, including for profile and
  announcement copies. An authoritative group continues to allocate its canonical
  S2S facts through `metaEndId`; a mirror leaves `metaEndId` at zero and tracks
  source progress only with target, processed, and recovery fields. Source fact
  IDs stay in source-fact storage and are never copied into `metaEndId`.
- Count must be a durable, coordinate-bound projection. Do not inject today's
  count into a response bounded by an older `through`.
- Every client-visible fact gets a unique locally allocated ID. Preserve the
  existing scalar client cursors and full/delta paging; do not add a composite
  cursor or a new client synchronization protocol.

### Independent client allocation and serving projection

The final storage direction was agreed on 2026-11-23: a separate client table
and a separate client allocator, for both authoritative groups and mirrors.
This supersedes the earlier proposal to reuse `metaEndId`.

Keep `GroupMetaMemberFeed` as the canonical/replicated server facts, including
members, and leave the S2S four-operation contract unchanged. `ClientGroupMetaFeed`
holds at most one current row per group and operation: `GROUP_MEMBER_COUNT`,
`GROUP_PROFILE`, and `GROUP_ANNOUNCEMENT`. This is not a second member roster.
Client and S2S operation unions remain separate.

`GroupMeta.clientMetaEndId` starts at zero and allocates every client version.
`ClientGroupMetaFeed.sourceFeedId` optionally identifies the source profile or
announcement fact for replay detection; it is never used as a client cursor.
Locally derived counts have no source feed ID. Even on the authority, copying a
profile/announcement to the client projection allocates a client ID independently.

- Client `groupMetaFeedEndId` comes from `clientMetaEndId` after cutover.
- Existing S2S head and audience-floor handling continue to use an authoritative
  group's canonical coordinates, not the new client allocator. Mirror publication
  must not derive a source head from its zero local `metaEndId`; source progress
  uses its dedicated cursor fields.
- Member-only server changes do not advance the client allocator unless a
  client-visible projection changes. Count-only client publication cannot advance
  the canonical allocator or remote processed cursor.
- Retain group-scoped lock order and allocate under a GroupMeta non-key write
  lock. Facts, cursor allocation, and required fanout admission commit together.
- Numeric equality of IDs from the two streams has no semantic meaning. Never
  compare or substitute them, or derive client progress from an incoming target.

Example for an origin:

```text
server metaEndId 40; clientMetaEndId 12; published count 100
role-only MEMBER_UPSERT: server metaEndId 41; clientMetaEndId remains 12
new member: server metaEndId 42; client count becomes 101 at client ID 13
```

Example for a mirror:

```text
remote batch through 900; metaEndId remains 0; clientMetaEndId 12
apply joins and departures with final count still 100
remote processed cursor = 900; clientMetaEndId stays 12
next remote batch through 950 changes count to 101
remote processed cursor = 950; client count gets ID 13; metaEndId remains 0
```

Switch client head readers and the client portions of inline membership SQL to
the new allocator/projection without changing S2S fields. Keep source recovery
and successful roster initialization distinct from client allocation. Before
runtime cutover, settle old client cursor/watermark migration; a client allocation
alone is not evidence that a complete source roster has been established.

### Announcement and recovery invariants

Keep announcement copy times, explicit clears, and read-watermark behavior.
The client announcement's `feedId` and its account-local read watermark use the
local client coordinate, not the mirror's source coordinate. Source revision and
copy-time metadata remain server-side so replay of the same origin fact does not
allocate another client version. A newly observed origin announcement version
can represent a real edit even if its text matches an older local version; do not
apply the count's value-only comparison rule to announcement version selection.
Absence of an announcement fact is distinct from `{ text: null }` at a coordinate.
`POST /group/announcement/set` and `POST /group/announcement/read` remain; the set
result must identify the client-visible version, and read validates against the
client projection. Acknowledgement uses the coordinate actually displayed, even
if a newer edit arrives before dismissal. Clients do not need to submit a second
S2S coordinate. Migration must preserve already-read semantics or explicitly
reset/rebase the old client cache and watermarks together.

Retain the existing currentness gate for automatic announcement presentation.
An incomplete recovery must not publish a partial count or announce stale cached
content as current. Persist displayed facts and their progress atomically. Keep
group-profile references and the existing profile-namespace resolution path.

## 3. New member query endpoint

Add `POST /api/v1/group/members`. The member list, member search, and mention
picker use this endpoint; do not add a separate mention-specific endpoint.
Examples below show the data payload without the existing common API envelope.

Request:

```json
{
  "threadId": 123,
  "search": "alice",
  "excludeSelf": true,
  "take": 50,
  "cursor": null
}
```

- `threadId`: required local group conversation ID.
- `search`: optional; absent or trimmed empty means the unfiltered list.
- `excludeSelf`: optional, defaults to false; mentions request true.
- `take`: optional, defaults to 50; integer from 1 to 100.
- `cursor`: optional/null on the first page; otherwise the opaque returned cursor.

Response:

```json
{
  "items": [
    {
      "account": "alice",
      "publisherNamespaceId": 7,
      "profileNamespaceId": 2,
      "profileRev": 15,
      "role": "MEMBER"
    }
  ],
  "nextCursor": null
}
```

The four identity/profile fields reuse `ProfiledAddress`; role is `OWNER`,
`ADMIN`, or `MEMBER`. Do not return display name, avatar, bio, or a wire domain.
Resolve display domains through the existing publisher/profile namespace binding.
`nextCursor: null` means exhausted; a redundant `hasMore` is unnecessary.

### Authorization, search, and pagination

- Require current permission to query the roster on every request. Historical
  message visibility alone is insufficient. Guards are not a substitute for
  reading authorization and page data in one consistent read-only snapshot.
- Query the serving server's committed canonical or mirror facts; never perform
  a cross-server roster search for every keystroke.
- Search account and the server's cached selected profile name. Missing profile
  data does not remove a member from the unfiltered/account-search results.
  Queries do not block on fetching every missing profile. Nickname results may
  improve when the selected profiles become available.
- Trim search; limit it to 128 characters. Use PostgreSQL `lower` and `strpos`
  for case-insensitive literal substring matching (no caller-controlled wildcard).
  The existing thread/member index scopes candidates and the complete Profile
  primary key selects cached names. This is a group-scoped scan, not an indexed
  substring search. Use parameterized queries and bounded page sizes.
- Use deterministic identity-based keyset ordering, not offset pagination or
  dynamically resolved display-name sorting. Namespace identity participates in
  ordering and deduplication; account alone is not globally unique.
- Bind and validate cursors against the group, normalized search, exclusion
  settings, and ordering version. A cursor never grants access.
- Each page reads current committed state; there is no cross-request frozen
  roster snapshot. New members before the cursor can appear on a refresh.
  Deduplicate accumulated results by identity and restart after search changes.
- An initializing mirror must not present an incomplete roster as a complete
  empty result: return `GROUP_MEMBERS_NOT_READY` (40009) until initial committed
  state exists. A missing recognized local namespace binding also uses this
  result. Later full recovery serves the previous committed roster, since full
  replacement is atomic; it does not introduce a query-blocking recovery state.

### Profile integration

Immediately show account fallback, then resolve/subscribe using the existing
profile repository. Keep cache keys, revision selection, evidence rules, and
cache-only behavior unchanged. Do not trust arbitrary references supplied back
by a client as authorization for a new profile fetch.

A page's selected identity/revision supplies profile demand; profile availability
updates presentation, not membership, role, ordering, or count. Revision zero
retains fallback without issuing an invalid revision request. Do not promise that
historical messages automatically follow every future nickname revision.

Cancel or fence stale searches, page requests, and profile subscriptions on query,
thread, session, or component changes. Page-local caching is allowed; a new
background-synchronized client roster is not. Offline state must be explicit,
not reported as an authoritative empty group.

## 4. Membership system-message contract

Keep `GROUP_JOINED` and `GROUP_LEFT`; change their new-write payload to:

```ts
type MembershipSystemMessage = {
  type: 'GROUP_JOINED' | 'GROUP_LEFT';
  members: ProfiledAddress[];
};
```

Every address contains exactly the existing writer fields: `account`,
`publisherNamespaceId`, `profileNamespaceId`, and `profileRev`. New single-member
notices also use a one-element array, for both local and mirrored groups.

- Require a non-empty, identity-deduplicated array; no `$system` participant.
- Do not store names, localized text, domains, `isSelf`, `isInitial`, or batch IDs.
- Do not store a redundant count: the displayed total is `members.length`.
- Freeze participants and their known profile references when writing the event.
  Departures use the last known reference and retain cache-only resolution.
- Keep role and owner events unchanged; their existing singular fields remain.
- Read existing valid singular `member` join/leave content by normalizing it to
  one member. Reject simultaneous `member` and `members`. This does not restore
  support for retired generic actor/subject payloads.

Audit all consumers, not only the UI parser: writers, directed departure fanout,
profile-work extraction, membership-incarnation SQL, persisted profile revision
corrections, previews, and native readers. Array support must preserve local
revocation visibility boundaries and participant-specific authorization.

### Mirror batching and full initialization

A member upsert is not necessarily a join. Compare committed member state:

| Before | After | Notice |
| --- | --- | --- |
| Absent/departed | Present | Joined |
| Present | Present with new profile/role | None |
| Present | Departed/absent | Left |
| Departed/absent | Departed/absent | None |

For delta, use a fetched meta page as the logical batch boundary. Apply the
facts, aggregated notices, count projection, cursor, and durable fanout admission
in the same transaction. Emit at most one join and one leave notice for a bounded
batch, and none for an empty transition set. Preserve replay/concurrency fencing.

First complete mirror initialization announces its observed eligible roster as
joined. This is intentionally a local observation, not an assertion about the
members' original join times. Later full recovery compares the old and new
rosters; it must not announce every surviving member again. Missing members can
produce departures even though full pages contain no departure facts.

Keep full replacement atomic after collecting the complete bounded snapshot.
Do not publish partial full pages just to batch notices. Within that commit,
split notice participants into deterministic bounded chunks. Each chunk becomes
one message, and each message's count covers only that chunk. Select and test
explicit member-count and serialized-byte limits against existing message limits
before implementing; never silently truncate participants or create an unbounded
initialization message.

Persist enough state to distinguish first successful initialization from later
recovery. A processed cursor reset to zero is not proof of first initialization.
Preserve the existing suppression of meta-derived local departures already
announced by the relationship-intent owner, and the authorization checks for
local joins. Initialization/recovery must not bypass these rules.

## 5. Single-line presentation

Render membership rows as a name region followed by a nonshrinking localized
count/action suffix, with optional time. Names can be ellipsized; the count is
all participants in that message, not only the visible names or the group count.

- Derive the available row width from the chatbox, not the measured name length.
- Give the name region `min-width: 0`, hidden overflow, ellipsis, and no wrapping.
- Keep count/action on one line and prevent it from shrinking behind the names.
- Define narrow-width behavior: remove optional time first; use a compact suffix
  if necessary. Do not allow overflowing names to wrap or grow the row.
- All system-message variants remain one line with integer-pixel box height,
  line-height, vertical padding, and borders. A separate date separator is not
  part of the message's one-line content.
- Resolve profiles reactively without recomputing chat-message offsets when names
  arrive or change. CSS must enforce geometry before asynchronous data arrives.
- Chatbox width changes use the existing shared layout/reflow pipeline for the
  complete message list. CSS preserves the system row's no-wrap constraint
  immediately, without waiting for that pipeline.
- Keep `offsetHeight`; do not substitute transform-sensitive bounding rectangles.
- Release per-member subscriptions on row reuse/destruction and bound active work
  to rendered rows. No one-off whole-roster profile subscription is introduced.

## 6. Implementation sequence and review gates

1. Resolve count-coordinate storage, query matching/cursors, readiness errors,
   message size bounds, and old-client rollout. Review the concrete contracts in
   the main session before code changes to those areas.
2. Implement the server member-query capability under the group domain with DTOs,
   authorization, search, pagination, generated API types, and database tests.
3. Implement the durable count projection and filtered client feed. Preserve S2S
   member facts, full/delta semantics, head publication, and announcement gates.
4. Add shared array-message parsing/writing and migrate every dependent consumer.
   Implement mirror batch transactions and initialization/recovery distinctions.
5. Move browser and native member-list/mention queries to the server. Keep profile
   caching intact; adapt subscriptions that previously relied on roster wakes.
6. Remove client member-event application and obsolete roster storage through
   versioned IndexedDB/SQLite upgrades. Retain group-level fields and cursors.
   Do not delete profile caches or unrelated local data.
7. Add single-line rendering and resize/profile-arrival regression coverage.
8. Update current API, architecture, Group Meta, announcement, system-message,
   and browser/native acceptance documentation to match the implemented state.

Old clients currently expect member events and singular system messages. Define
coordinated deployment/version gating rather than silently returning incomplete
rosters or unreadable new messages to supported older clients. Existing client
cursors also need a bootstrap rule that guarantees receipt of the new count
projection; preserving an old cursor alone is not sufficient proof of that.

Add new deployed-schema migrations; never rewrite existing migrations. Keep
unrelated in-progress work intact. This plan does not authorize a protocol change
or a parallel platform-specific native implementation.

## 7. Validation checklist

- [ ] Count full/delta, explicit zero, equal-count membership replacement,
      profile-only changes, filtered empty pages, and bounded through scans.
- [ ] Count-coordinate collisions, compaction, initial mirror recovery, later
      recovery, crash/rollback, replay, concurrent rounds, and bootstrap upgrades.
- [ ] Announcement publish/edit/clear, freshness, read-coordinate races, and
      recovery retaining the currentness gate.
- [ ] Member query authorization/revocation, local and mirrored groups, duplicate
      accounts in different namespaces, cursor misuse, concurrent roster changes,
      account/name search, missing profiles, and self-exclusion.
- [ ] Shared singular compatibility, invalid/empty/duplicate arrays, bounded
      payloads, profile extraction, incarnation checks, and directed fanout.
- [ ] Multiple joins and departures, mixed batches, profile/role-only upserts,
      initial full notices, recovery diffs, and intent-owned local departures.
- [ ] Browser/Rust parity, populated-cache upgrades, offline queries, session
      cancellation, unchanged profile cache/evidence behavior, and no roster drain.
- [ ] Long names, many names, delayed profiles, locales, narrow widths, time
      display, date separators, and stable integer `offsetHeight` after updates.
- [ ] PostgreSQL-backed transactional and concurrency tests, plus targeted browser
      and native tests; report actual commands/results rather than assumed CI.

## 8. Implementation entry points

- [Client meta controller](../../src/controller/user.controller.ts)
- [Client meta service](../../src/client-state-feed/client-group-meta-feed.service.ts)
- [Shared server page reader](../../src/group/meta/group-meta-page.ts)
- [Mirror delta application](../../src/group/meta/apply-delta-mirror-meta-item-in-tx.ts)
- [Mirror full application](../../src/group/meta/apply-full-mirror-meta-batch-in-tx.ts)
- [Mirror round executor](../../src/federation/federation-thread-meta-round-executor.service.ts)
- [System-message contract](../../shared/system-message-content.ts)
- [Profiled address](../../shared/profiled-address.ts)
- [Browser meta synchronization](../../web/src/app/services/group-meta-sync.ts)
- [Client meta model](../../web/src/app/services/group-meta-model.ts)
- [Current local member reader](../../web/src/app/services/member-profile-store.service.ts)
- [System-row renderer](../../web/src/app/components/message-cards/system-row/system-row.component.ts)
- [Native attention runtime](../../src-tauri/src/native_db/attention.rs)
