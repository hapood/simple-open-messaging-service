# Development handoff: message and tombstone pull

Read `docs/design/federation-message-tombstone-pull.md` first. It is the target
behavior. This file is the work order for a later session. Do not treat
`federation-consumer-rounds.md` or
`federation-atomic-rounds-and-history-gaps.md` as the target. They describe the
scheduler the code runs today.

The federation wire did not gain parameters or response fields. `spec/v1` is
unchanged. Deletions of existing usage text and of the entry-gap path are
listed only under Remove below. Source behavior of `scannedThrough` is
unchanged.

## Current execution order (2026-11-22)

Work in the main agent only; do not delegate code inspection or implementation
to subagents. Keep unrelated workspace changes intact and do not commit without
an explicit request.

### Latest reviewed implementation decisions

These decisions supersede the earlier dual-table and rejected-prefix instructions
below; those older descriptions are not acceptance criteria for the next edits.

- Unify backend deletion facts in `MessageTombstone`, with explicit LOCAL versus
  FEDERATED provenance and retained `consumed` state. Migrate the responsibilities
  and data of `DeletedMessage` before dropping it; keep local deletion coordinates
  distinct from remote coordinates. Local-authority deletions use the same table.
- Perform pure message validation, transformation, and digest calculation before
  the write transaction. Existing remote message coordinates are warned and
  skipped without envelope-digest comparison. Compare local processing-receipt
  payloads outside the message transaction, warn on mismatch, and commit receipts
  in their own locked transactions. Retain commit-time authorization and coordinate
  safety checks, not a compatibility path through the old page applier.
- Use one direction-independent message-page commit contract with a required
  continuous processed interval. Intentionally filtered items count as processed;
  do not retain `rejectedSeq`, rejection callbacks, or stop-at-first-invalid
  behavior. Storage failures still roll back rather than advance progress.
- Determine gap progress in the message write transaction. After successful commit,
  check history subscriptions only when at least one message was actually stored.
  Look up the thread index first, then match overlapping local intervals, not
  exact boundaries or endpoint containment.
- For new reverse gap reservations, derive publisher coverage from the local
  anchor message (`messageProcessedThroughSeq` -> `originSeq`) and existing
  `FederationThreadHistoryGap` rows for that `(threadId, namespaceId)` without
  adding a separate `messageReservedThroughSeq` column. Compute the additive
  offset as `curSeq + 1 - firstOriginSeq` (where `firstOriginSeq` is the first
  newly reserved publisher sequence `coveredThroughSeq + 1`), and advance
  `messageProcessedThroughSeq` to the local `seq` of the highest stored
  `originSeq` message from that publisher. Existing gaps retain their fixed
  mapping. Message writes and the monotone local sequence allocator update
  commit atomically under the thread lock.
- The requested history-subscription capacity is 100 with oldest-subscription
  eviction, an explicit client error, and manual retry rather than automatic
  reconnect on eviction. Whether the limit is per session or per process still
  needs confirmation; keep the existing thread index and overlap predicate.

### Phase A: finish and validate the existing work

- [x] Unify `DeletedMessage` and `FederatedMessageTombstone` into
  `MessageTombstone` (`LOCAL` vs `FEDERATED` provenance, retained `consumed`
  state) in `src/database/schema.ts` and
  `database/migrations/0001_federated_message_tombstone_consumed.sql`. Update
  obsolete row-deletion assertions and verify unconsumed logical gaps in client
  and peer queries. Insertion marks `consumed = true` without allocating a
  local `deletionSeq`.
- [x] Complete the common per-message-round preparation path
  (`FederationInboundMessagePreparationService`,
  `FederationInboundMessageReceiptService`, and
  `FederationInboundMessagePageService.prepare` / `applyPrepared`), removing
  per-item `SAVEPOINT` / `FEDERATION_MALFORMED` swallowing inside the write
  transaction and removing `domain`/`peerDomain` from business logic.
- [x] Prevent concurrent forward/reverse message execution for the same thread,
  while keeping tombstone work independent. Callers use `mode: 'thread' | 'meta'`;
  the scheduler selects message direction and rejects mismatches, with a DB
  trigger forbidding `FederationThreadHistoryGap` on local-authority group
  threads.
- [x] Separate reverse page/gap completion from history completion. Only the
  agreed remote message-end error completes reverse history; ordinary errors do
  not retry locally and follow in-memory cooldown / scheduler policy.
- [x] Cover the full reserved tail in read-position initialization, removing the
  extra subtraction of one.
- [x] Validate the unified `MessageTombstone`, reverse anchor/offset reservation,
  cancellation, and two-node reverse/missed flows against PostgreSQL.

Validation checkpoint (Phase A backend complete; Phase B remains deferred):

- `npm run build` and `npx tsc --noEmit` (zero errors in production `src/`).
- `npx eslint` on `src/federation/`, modified `src/message/` files, and
  modified `test/` files passed with zero errors.
- `npx vitest run src/federation/ src/message/` passed.
- PostgreSQL E2E suites (`federation-thread-sync-state`,
  `federation-reverse-tail-state`, `deleted-message-concurrency`,
  `federation-member-tombstone`, `federation-message-tombstone-feed`,
  `federation-quote-coordinates`, `federation-state-boundaries`,
  `federation-thread-reverse-two-node`, `federation-missed-two-node`,
  `federation-group-receipt`, `mirror-group-intent`, `message-history-gap`,
  `message-history-interval`, `message-report`, `message-report-http`,
  `peer-state-feed`, `federation-pending-media-promoter`,
  `federation-three-node-contract`, `federation-message-feed`,
  `federation-message-provenance`, `federation-message-roundtrip`,
  `federation-forward-quotes`, `federation-group-media-authorization`,
  `federation-thread-parent-lock`, `first-message-after-friend`,
  `message-visibility`, `message-search-pagination`, `mark-read`) passed.
- Note: `src/database/schema.spec.ts` and `test/federation-feed-head-receipt.e2e-spec.ts`
  still assert that `0000_base.sql` is the sole migration until unreleased
  migrations (`0001_federated_message_tombstone_consumed.sql` and unrelated WIP
  `0002_client_group_meta_projection.sql`) are squashed into `0000_base.sql`.
  Unrelated WIP failures in `group-meta-*`, `thread-attention`,
  `departure-system-message` (mirror meta), and `federation.e2e-spec.ts`
  (`storeFederationQuote` / `metaRecoveryThroughId`) were left untouched.

### Phase B: deferred client state feed and scheduler

Implement only after Phase A acceptance. The detailed follow-up contract and
migration/test checklist are in [client-misc-state-feed-dev.md](client-misc-state-feed-dev.md).

- [ ] Add explicit state-feed item types `REQUEST_HEAD` and
  `THREAD_RESOURCE_HEAD`, using `{ feedId, type, body }`; reuse the existing
  `STATE_FEED_UPDATED` wake and account feed cursor.
- [ ] Move tomb/meta synchronization heads out of thread feed. Preserve request
  attention, authorization, full recovery, and list order for resource-only
  changes, including preview updates caused by deletion.
- [ ] Remove chat-open-driven tomb/meta pulling. Initialize equivalent Web/Rust
  singleton schedulers with in-memory queues, active sets, dirty flags, and retry
  timers; persist only targets/progress for restart recovery. Omit message-round
  scheduling from this simplified scheduler. Tomb concurrency is 4, meta is 2,
  with no additional combined limit.
- [ ] Schedule from committed resource heads and cache-growth wakes; preserve
  no-progress cutoff stopping, fair page rounds, and login/cache-generation
  cancellation. Reuse native HTTP clients across configured origins.
- [ ] Remove IndexedDB `messageDeletions` and SQLite `message_deletions` through
  versioned upgrades after replacing their deletion-state, history-marker, and
  stale-response safety responsibilities. Keep backend tombstone tables.
- [ ] Remove meta-triggered profile prefetch in both hosts, retaining independent
  display-driven profile loading and thread-filtered chatbox deletion listeners.
- [ ] Validate mixed typed feeds, unopened-thread/headless execution, upgrades,
  restart recovery, bounded concurrency, races, and stable list ordering.

## Decisions already made

- Ordinary message pulls may use either cursor. Keep the forward consumer.
  This server's default for P2P and for a mirror pulling an authority timeline,
  including a new tail, is the reverse page in the design document. Do not
  invent a second automatic selector.
- The group origin pulling a member home's submissions is always forward, from
  the last accepted submission sequence, with `includeSelf=false`. Do not
  reverse-fill that stream.
- Tombstone query stays forward. `after` is the last applied tombstone
  sequence. `through` is the lightweight tuple's `tombstoneEndSeq`.
  `maxMessageSeq` is the greatest message `seq` stored in that database now,
  without capping it at the tuple's `messageEndSeq`. It is not the sequence from
  the previous drain. The client uses its own database the same way. The coordinate
  space matches the message pull.
- Do not store the response `scannedThrough` as the applied tombstone cursor
  when `maxMessageSeq` excluded rows. The next `after` is the last tombstone
  actually applied.
- Message insert only looks up `FederatedMessageTombstone`. A later tombstone
  is the drain. Same transaction: `DeletedMessage` plus `Message.isDeleted`,
  or only the pending tombstone when the row is absent.
- A received quote is stored as the wire `seq` or `originSeq`, without
  rewriting one into the other. Bundle `quoteTargetId: 0` renders as an error
  quote on the quoting message. An envelope quote coordinate of 0 rejects the
  message.
- Client entry-gap replacement (`planEntrySuffix`, `loadEntryGap`,
  `planEntryGapReplacement`) is to be removed. It conflicts with the 70%
  viewport follow rule. Server gaps are not stable rows. First open shows a
  spinner, not a gap row. A visible server gap subscribes; the client then
  reads one local page of 50 and splices that interval. Arrival `requestNewer`
  runs only when the thread's latest message is already mounted.

## Implement

1. Tombstone drain. Change the forward tombstone round so an ordinary head uses
   the cutoff above. Keep reauthorization able to send `maxMessageSeq`, but do
   not require every later drain to omit it. Files:
   `src/federation/federation-thread-forward-round.service.ts`,
   `src/federation/federation-thread-sync-state.service.ts`, and the tombstone
   page commit path. Tests that expect `deletionRecoveryMaxMessageSeq` to be
   the only sender of `maxMessageSeq` need new cases for the ordinary cutoff.

2. Group submission pull. Keep it on the forward message round. Make sure a
   locally authoritative group does not open a reverse gap for member
   submissions. The activation branch that leaves the newest advertised message
   to the forward query stays for that stream only.

3. Ordinary reverse tail. For P2P and mirror timelines, put the newest
   publisher sequence inside the reverse gap instead of leaving `(E-1, E]` to
   the forward round. Reserve `messageSeqOffset` through that newest sequence.
   Page size stays 50. Discard an in-flight page whose `before` is not the
   current upper edge. Fan out only the page that advances the visible tail.

4. Message insert. On the reverse store path, the tombstone check stays a
   single lookup. Do not run the drain inside insert. Stop rewriting
   `quoteTarget` in `src/federation/federation-quote-target.ts`
   (`storeFederationQuote`). Persist the wire discriminant.

5. Client window, after the server pull commits the tail and the gap. Follow
   `docs/design/chat-server-gap-and-arrival.md`. Remove the entry-gap
   replacement. Gate arrival load on the mounted latest message. Render a
   server gap as a subscribed row and splice only that interval.

## Remove

These removals stay in this development note. Do not put them in the formal
design documents or in `spec/v1`.

- Message-feed usage that requires ordinary forward processing to continue
  after reverse reconstruction, and the tombstone-feed and protocol usage that
  allows `maxMessageSeq` only on the first post-reauthorization drain and
  requires every later drain to omit it. Leave the query parameters and the
  source `scannedThrough` rule in place.
- The temporary entry gap: `planEntrySuffix`, `cb-entry-gap`, `loadEntryGap`,
  and `planEntryGapReplacement` in
  `web/src/app/lib/chat-box/entry-window-splice.ts`. The suffix-and-unmount
  replacement conflicts with the 70% follow rule.
- The newer-demand edge check in `syncDemandRegions`
  (`web/src/app/lib/chat-box/chat-box-scroller.ts`) as the arrival gate. Arrival
  load is the mounted-latest-message rule in
  `docs/design/chat-server-gap-and-arrival.md`.
- The `originSeq` to `namespaceId = 0` rewrite in `storeFederationQuote`.

## Do not

- Do not add a federation parameter or change source `scannedThrough`.
- Do not delete the forward query handler. This server still answers both
  directions.
- Do not soft-delete by writing the tombstone body onto `Message`. The flag is
  `isDeleted`. The fact is `MessageTombstone`.
- Do not enqueue per-message fan-out for an older gap page.

## Assumption

Ordinary P2P and mirror pulls default to reverse, including the new tail.
Forward remains implemented for the group-submission stream and as a supported
source query. Local callers do not select a direction: they wake a thread, and
the scheduler selects the direction from its source. There is no automatic
fallback that switches an ordinary thread between directions.
