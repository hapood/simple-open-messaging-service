# Chat history entry and message windows

> The later [window loading and sending-task design](chat-window-loading-and-sending-tasks.md)
> supersedes this document's optimistic/pending-in-history presentation and
> skeleton rendering details. Cache entry, finite suffix requests, gap replacement,
> and ordinary history-demand policies remain applicable. Sending tasks now belong
> to a header indicator and task panel, not the mounted history window.

Status: the original review was on 2026-11-11. The entry contract was subsequently
clarified: freeze the effective read cursor and inspect a local-only window around
that cursor, not the latest cached batch. Both cached and cold entry use the same
read-position alignment. The current implementation includes this entry path,
shell readiness independent of history readiness, and query-consumer cancellation
for older/gap demands. This is not a claim of complete history-window acceptance.

### Current entry contract (takes precedence below)

1. Capture the effective read cursor `R` before visible-message tracking begins.
2. Read the local cache around `R`: the older half includes `R`, and the newer half
   excludes it. For `R = 0`, read only the beginning-side newer half.
3. Retain and mount that cached window if it contains message or gap items. Do not first mount
   a latest-cache batch, issue a special suffix request after `R`, or create a
   temporary entry gap merely to join the two batches.
4. If the local read is empty, keep the whole-window skeleton while performing
   the ordinary around read (or `newer(after: 0)`). A cache-read failure remains a
   retryable failure, not evidence of an empty cache.
5. Position the returned read target near the center where possible. Missing
   targets retain surrounding messages without choosing a substitute target.
   Ordinary independent edge demand takes over after measurement and positioning.
6. The bound foreground shell and permitted composer do not wait for kernel
   initialization. Read advancement still requires actual visible history.

The earlier latest-cache seed, one-shot suffix, and temporary entry-join proposals
in sections 3.1, 3.3, 3.4, and 4 are retained as historical design context, not the
current ordinary-entry algorithm. The checkpoint table and implementation-gap
observations also predate this clarification; they are not a current task ledger.
Existing generic gap behavior is not removed by this entry-path change.

The local-only read uses the source's existing directional range traversal. Each
half stops at the first unknown IDB/SQLite interval and returns its connected
projection with that edge still open. It never skips an unknown interval to reach
another cached batch. Continuity is defined by coverage, not consecutive message
IDs. A server gap is projected as one window item and is not an unknown interval
to fill; no gap message is persisted by entry loading. A gap-only result is a
valid window projection, not an empty-cache fallback. This is an implementation
constraint of the existing source contract, not a new design review gate.

## 1. Scope and precedence

This design changes ordinary thread-item entry, read-position loading, temporary
entry gaps, loading presentation, and bottom following. It preserves the
[canonical message-range model](./client-message-history-sync.md) and the
[conversation binding lifecycle](./chat-surface-binding-lifecycle.md).

For these interactions, the target behavior below replaces automatic remote
latest-page fallback after an empty local read and the blanket policy that
initial catch-up never follows the bottom. Explicit go-to-bottom remains a
separate operation and may request the latest page.

This is a shared Web presentation and message-window coordination change,
including the Web UI hosted inside native clients. Implementation is limited to
Web components, the scroll kernel, presentation-source coordination, and their
tests. Reuse existing cache reads and `around`, `older`, `newer`, and explicit
`latest` operations.

Do not modify Android/Kotlin implementation, Rust history/runtime code, backend
protocols, database schemas, range reducers, unread-count eligibility, account
synchronization ownership, or persisted server-gap semantics. No cache reset or
migration is part of this work. If an existing interface proves insufficient,
stop and review that limitation before expanding the scope.

## 2. Coordinates and sources of truth

Use distinct names for these facts:

| Fact | Meaning |
| --- | --- |
| Entry read cursor `R` | Effective `lastReadSeq` captured when opening the conversation. Inclusive last-read position; always a coordinate, possibly `0`. |
| Local mounted tail `C` | Maximum real message sequence in the current mounted window. Not the thread's remote head. |
| Known head `E` | Greatest applicable message-end coordinate from durable thread metadata and live feed/push observations. |
| Unread boundary | Existing entry-frozen unread marker, derived under the current unread rules. It is not the loading cursor itself. |
| Covered range | A committed scan represented by canonical local ranges. Presence of endpoint message rows alone is not proof of continuity. |

`R = 0` is valid: it is the exclusive coordinate before the first message, not a
message that must resolve. A positive entry read cursor does not require a
renderable message at that exact coordinate. Retention or deletion may remove
the target without invalidating the surrounding history or unread boundary.

If an entry query returns messages but not the exact positive target:

- mount the returned history normally;
- derive and render the unread marker under the existing unread rules, independently
  of target-row existence;
- log a diagnostic `console.warn` and skip only target-specific centering;
- complete the loading presentation and re-evaluate both edge demands normally;
- do not enter an unavailable state, discard the returned page, select a substitute
  centering target, or fall back to latest merely because the target is absent.

For example, with `R = 100` and returned messages `99, 101, 102`, display those
messages and, when unread eligibility applies, place the unread marker before
`101`. Do not attempt to center a nonexistent message `100`. An entirely empty
query result still follows ordinary successful-empty versus failed-query rules;
absence of the target alone is not evidence of empty history.

The unified thread feed persists read-position metadata. Local read progress and
server read progress have separate storage fields; entry must use the effective
read cursor, not overwrite local progress with a stale server snapshot. Freeze
`R` before first visible-message tracking can advance it. Reconnects, later feed
updates, and read acknowledgments must not silently move this entry's target.

Thread previews are stored separately from message bodies. A populated preview
and a nonzero `E` do not imply any locally cached timeline messages. A cache-read
failure must not be mistaken for an empty cache.

Unread eligibility is unchanged: show the unread marker only when the existing
unread rules say there are unread messages. Do not substitute `E - R` for the
unread count; own messages, deletions, and coordinate holes make them different.
If `R = 0` and there is unread content, place the marker before the first message.
If unread count is zero, the cursor still determines loading and positioning,
but no unread marker is rendered.

## 3. Ordinary thread-item entry

### 3.1 Preparation

On a new ordinary entry:

1. Bind the conversation and capture its effective read cursor and unread state.
2. Inspect the local message-body cache and retain the initial local batch.
3. Select the empty-cache or nonempty-cache path below.

The local inspection may read the latest locally cached batch. This is not an
authorization to request the server's latest page. The retained batch should not
be fetched again solely to make the entry decision.

Normal entry must not silently switch to remote latest because there is no
mounted real cursor. Explicit search and go-to-bottom are distinct intents.

### 3.2 Empty local message cache

Present a history skeleton while retaining the conversation composer. Load a
bidirectional window around `R` and position `R` near the viewport center where
geometry permits, reusing the existing centered search/jump positioning
capability rather than introducing a second positioning algorithm.

For `R > 0`, use the existing around operation: the older half includes the read
coordinate and the newer half is exclusive of it. For `R = 0`, there is no older
half: use the existing newer operation with `after: 0` and position the available
beginning without requiring a message at sequence zero. Do not extend the Rust
around contract to accept zero, and do not recover this case by loading the
newest page.

After the initial window is measured, reveal it with the applicable unread
marker and synchronize both edge demands. Centering can clamp near the beginning
or end of history; do not invent blank historical messages to force centering.

A skeleton represents an in-progress window load, not an empty conversation.
Failures must remain retryable and must not manufacture oldest/newest boundaries.

### 3.3 Nonempty local message cache

Mount the retained local batch first. Immediately after the completed
mount/measurement/positioning transaction, check both edge-demand regions. A
short list can require older and newer loads at the same time.

If the known `E` message is present in the retained local cache, finish entry
loading with that mounted batch. Do not issue a one-shot entry request or flash
a bottom spinner; ordinary edge demand takes over. This cached-head fast path
is the exception to the suffix request below.

Otherwise, the entry's newer-side request starts at **`after: R`**, excluding `R`, even if
`C` is greater than `R`. Do not replace this cursor with `max(R, C)` and do not
sequentially chase from `C` merely to reach `R`. Use the ordinary bottom loading
spinner for this request, not a whole-window skeleton.

Merge the returned committed message segment with the mounted cache:

- Deduplicate overlaps by message identity and preserve existing message
  instances and screen positions as far as possible.
- A temporary entry gap represents history deliberately skipped by this window,
  not a claim about missing durable coverage. When the retained prefix ends before
  `R` and the entry response supplies a separated suffix, the kernel may connect
  them with an in-memory entry gap over the skipped interval.
- Resolve overlap against the window still mounted at delivery time before
  inserting a gap. Do not infer an entry gap merely from missing numeric IDs in
  a returned page. No native coverage API or additional Rust gap item is required.
- The skipped history may already be cached. Clicking the gap uses the ordinary
  source query, which decides whether cached or remote history is needed.
- If the response only overlaps the cache, it must not duplicate rows, move the
  reading position, or strand a still-needed bottom demand. Further work follows
  ordinary bounded viewport demand rather than an eager full-history drain.

Preserve the existing position during this entry splice. Exact preservation can
be impossible when the old content is shorter than a viewport, replacement
content is shorter than a loading indicator, or the resulting scroll range
clamps the offset. These are geometry limits, not permission to jump to latest.

### 3.4 One-shot entry demand within ordinary scrolling

After mounting a nonempty seed, the window immediately supports ordinary
scrolling and older paging. Its bottom demand slot initially owns one entry
request after `R`; do not start a competing ordinary newer request in that slot.
The first entry-demand response, not the preceding local cache read, performs
entry splicing and may create the temporary gap.

The request owns its state; the spinner DOM does not. Reuse the existing edge
status renderer, spinner, error/retry styling, and measured integer-pixel
heights. Do not introduce an independent entry-spinner visual implementation.

- While the request is pending, upward scrolling and ordinary older demand remain
  available. Use delivery-time mounted content and position for the splice.
- Logical removal of the bottom loading location, release of its demand ownership
  region, or window teardown cancels the request and consumes the one-shot entry
  opportunity. Merely leaving the visible screen or rebuilding the renderer does
  not count as logical removal.
- Returning to the bottom after retirement uses ordinary newer paging from the
  current window, not another entry request after `R`.
- A failed entry request retains its bottom error/retry presentation. Retry uses
  the same captured `R` while that entry-demand location remains owned. Retiring
  the location also retires this retry opportunity.
- Successful delivery ends the entry spinner, applies one atomic splice, and
  rechecks both ordinary edge demands. Cancelled late delivery cannot mount items
  or create a gap; already committed cache data is not rolled back.

Empty-cache entry remains a skeleton-owned window load, with no retained prefix
requiring a temporary join. It does not need a separate scrolling phase shared
with the one-shot bottom demand.

## 4. Temporary entry gaps

### 4.1 Meaning and persistence

A temporary entry gap means: this initial display deliberately joins two loaded
segments without loading the ordinary history between them.

It is not `SERVER_PENDING` or `SERVER_UNAVAILABLE`. Those states are durable
server facts, with their existing rendering and loading semantics. A temporary
entry gap is presentation-only, is excluded from all message-only behaviors,
and is never written as a message or a new durable range state.

For example, after loading an unread suffix:

```text
Mounted:  [1..50]  [temporary entry gap: 51..100]  [101..120]
Covered:  (0,50]                                  (100,120]
```

The coverage shown is one possible cache state, not a prerequisite for this
presentation. `(50,100]` may instead already be covered in storage. The temporary
gap describes only this window's skipped history, and never changes durable
ranges. Existing source-returned server gaps keep their distinct durable meaning
and may reappear on later queries; a retired entry gap cannot.

### 4.2 Click: load older history adjacent to the suffix

Direction is defined by this reviewed example, avoiding ambiguous words such as
"forward":

```text
Before: [1..50]  [entry gap]  [101..120]
Click:  query one older page immediately before the suffix (before: 101)
Result: [81..100] [101..120]
```

While loading, show a spinner in the gap's position. On successful completion:

1. Capture the suffix's current screen position at result delivery time.
2. Remove the old displayed prefix (`1..50`) and the temporary gap.
3. Prepend the new page (`81..100`) to the retained suffix (`101..120`).
4. Measure and restore the suffix position as far as the scroll range permits.
5. Recheck both ordinary edge demands. If the top region needs more history,
   show/use the ordinary top spinner.

This loads **one page**, not the entire gap. Do not retain a smaller clickable
entry gap after success. Any remaining older history is now outside the window
and is handled by ordinary older paging. Removing the old prefix is a viewport
operation only; do not delete its cached messages or ranges.

Keep suffix message instances where possible; do not tear down the whole
window to emulate this splice. Real server-gap items returned by the normal
walker retain their normal semantics. Success uses the same replacement operation
for every page shape: an empty page removes the prefix and gap and retains only
the suffix; a server-gap-only page replaces them with those server-gap items.
Do not infer an oldest boundary merely from the absence of message rows; retain
the source response's authoritative boundary evidence. A failed request does
not run this replacement: keep the prefix and gap and offer retry at the gap.

### 4.3 Lifetime, cancellation, and interaction

The entry gap is evictable. It must not use a kernel flag that pins transient or
optimistic rows against trimming.

- Clicking starts one gap-owned request; duplicate clicks cannot start siblings.
- Logical unmount, window replacement, or conversation unbind cancels that request
  and prevents late delivery from changing the window.
- A renderer rebuild is not logical unmount and must not accidentally cancel a
  still-mounted gap's request.
- Once unmounted, the temporary gap is forgotten for that window. Returning to
  the interval uses normal history loading; it does not recreate the entry gap.
- Retiring a gap does not cancel unrelated top/bottom demands, another window's
  reads, account feed synchronization, or an admitted durable cache transaction.

Use an accessible keyboard-operable action with localized loading/error labels.
Idle/loading states should share a deterministic integer-pixel row height to
avoid avoidable position shifts. Keep the existing `offsetHeight` measurement
contract. Gap rows never count toward unread, stable-read advancement, message
selection, sender/date grouping, albums, or arrival-count pin policy.

## 5. Edge-demand contract

The top and bottom have independent subscription ownership and may be active
simultaneously. A pending bottom subscription is also useful at the known head,
where it waits for availability; it does not require a visible spinner forever.

After **every completed mounted-window change**, re-evaluate whether either
edge needs data. This includes initial mount, edge delivery, entry suffix join,
gap replacement, explicit item mutation/removal, and relevant layout changes.
Check after boundaries, measurement, and anchor restoration, not halfway through
each individual row insertion. Serialize/recheck synchronous delivery so one
edge cannot act on geometry made stale by the other edge.

Mount a fixed first batch and complete its measurement and explicit positioning
before checking demand. Subsequent pages preserve the delivery-time reading
position; they do not reapply the initial target alignment. There is no separate
initialization fill loop or component-triggered backfill API.

Top loading requires the viewport to be inside its demand region and no
authoritative oldest boundary. A missing globally oldest cached message alone
is not a reason to load. Each direction stays single-flight, including errors
waiting for an explicit retry.

The bottom spinner remains applicable when:

- a centered/read-position window has more newer history to load; or
- `E` exceeds the current real mounted tail, including an end advanced by feed
  or push; or
- the nonempty entry's unread-suffix request is still in progress.

Actual work remains governed by viewport demand and availability. Distinguish
loading from a parked subscription at the current head, and preserve existing
retry/error states.

## 6. Bottom attachment and arrival batches

Remove the production-wide `followBottom: false` entry policy. Attachment is
geometric: when the viewport is at the bottom, ordinary new arrivals can keep it
there. Merely having the newest message somewhere in the mounted window does
not mean the user is at the bottom of the viewport.


- At the bottom, follow the arrival unless its measured added height exceeds
  70% of the viewport. The height rule and its fade consequence are defined in
  [chat-tail-sending-cue.md](chat-tail-sending-cue.md).
- A batch above that limit suppresses following **for that batch only**,
  preserving the existing reading position as far as geometry allows.
- There is no sticky unpinned state: on the next update, attachment is determined
  again from the current viewport position.
- A user above the bottom is not automatically pulled down.

Centered initialization, explicit go-to-bottom positioning, top history paging,
and replacement of the entry gap are not ordinary live-arrival batches. Their
explicit positioning rules must not be overridden by the threshold. The initial
nonempty-cache suffix join also retains its position-preservation contract from
section 3.3.

## 7. Skeleton, composer, search, and explicit latest

Use one message-window skeleton transition for:

1. empty-cache read-position initialization;
2. search navigation requiring a message-window load; and
3. explicit go-to-bottom when `E` is greater than the maximum real mounted
   message sequence.

Explicit go-to-bottom may still load the latest page. If the newest content is
already mounted, ordinary scrolling does not need a network-loading skeleton.
Search continues to use centered positioning. Whether an already-mounted search
hit needs any transition is a review item below; it must not acquire unnecessary
network work.

Keep the conversation binding, composer instance/draft, and permissions stable
through these message-window transitions. A skeleton must not hide an otherwise
available composer or grant input access in blocked/read-only states.

Separate **shell presentation readiness** from **history readiness**. The host
must be able to promote an incoming skeleton-plus-composer shell without waiting
for network history. Background A/B panes must still not steal focus or native
composer ownership. Stable-read advancement requires actual visible messages,
not merely shell readiness.

For native-hosted Web UI, adjust the existing Web-side composer visibility and
readiness conditions only, without weakening binding, foreground, or permission
checks. Reuse the current composer bridge. No Android adapter or Rust runtime
change is included.

## 8. Ownership and implementation constraints

| Owner | Responsibility |
| --- | --- |
| Thread entry/window coordinator | Capture the entry cursor, choose local/empty mode, coordinate skeleton and readiness, apply explicit positioning intent. |
| Web presentation source | Execute existing local/directional queries and pass consumer cancellation through existing APIs; preserve source-returned durable server gaps. |
| Existing repository and native history owner (unchanged) | Continue owning IDB/SQLite/HTTP/range walking, commits, and cancellation under their existing contracts. |
| Generic scroll kernel | Own mounted-entry lifetime, atomic window splices, measurement, anchor restoration, edge subscriptions, and attachment mechanics. |
| Gap renderer | Render idle/loading/error action and report user intent; no direct SQL, IDB, or HTTP decisions. |
| Thread attention/read services | Continue owning effective read progress, unread eligibility, and stable-read commits. |

Do not duplicate the native walker in TypeScript or introduce a new page-level
native orchestration path. Presentation coordination composes existing
source-level operations; cursor-zero entry uses `newer(after: 0)`. Preserve the
canonical reducer and commit-before-publish rule without changing them. Display
concatenation never changes durable coverage by itself.

Exact Web presentation method names are not approved by this behavioral design.
Review them before implementation. Transport/result contracts remain unchanged.
Favor explicit entry and window operations over new combinations of unrelated
loading flags.

## 9. Current implementation gaps

Code inspection at `c1e74e0f` found:

- [HttpItemSource](../../web/src/app/components/message-thread/http-item-source.ts)
  uses local latest during initial DB loading and remote latest for an empty
  newer cursor afterward; there is no reviewed read-entry plan yet.
- [MessageThreadComponent](../../web/src/app/components/message-thread/friend-message.component.ts)
  uses `followBottom: false` and ends normal initial loading before remote
  catch-up. Its skeleton/readiness and native composer gates need coordination.
- [ChatPaneComponent](../../web/src/app/components/desktop/chat-pane/chat-pane.component.ts)
  waits on readiness before promoting an incoming pane; adding a child skeleton
  alone will not establish the new presentation contract.
- [ChatBoxScroller](../../web/src/app/lib/chat-box/chat-box-scroller.ts) already
  has independent older/newer demand owners, but not every mutation path
  rechecks them. Existing mutation helpers do not establish all guarantees of a
  suffix-preserving prefix replacement.
- [Canonical ranges](../../web/src/app/services/message-range.ts) already
  support disconnected coverage. Existing rendered gaps represent server facts,
  not cancellable, disposable entry bridges.
- Existing [history query operations](../../web/src/app/services/message-repository.service.ts)
  provide the needed bidirectional reads. Web coordination must route entry at
  zero through `newer(after: 0)`, and pass gap-owned cancellation through the
  existing request signal rather than changing the native history contract.

These are implementation observations, not reasons to retain the superseded
behavior. Existing tests that assert empty-cache catch-up stays at scroll offset
zero must change together with the relevant reviewed behavior.

## 10. Incremental review and development

All implementation and code edits are performed in the main working thread.
Read-only investigation may be delegated; subagents must not edit implementation
files. For each checkpoint: review the contract and edge cases, implement only
that step, run meaningful tests, report the diff and remaining gaps, and pause
for review before the next step.

| Checkpoint | Review and implementation scope | Minimum acceptance evidence |
| --- | --- | --- |
| 1. Entry facts and source contract | Freeze effective `R`; distinguish empty cache/error; retain seed; define zero/missing target handling through existing query operations. | `R=0`, positive `R`, missing positive target with surrounding messages and an unread marker, zero unread, advancing read/feed state, empty versus failed cache read; no accidental latest fallback. |
| 2. Shell and centered empty entry | Skeleton with available composer; separate shell/history readiness; centered initial window; search and explicit latest transitions. | Slow/offline HTTP, retry, A/B switch, draft/composer identity, no premature read advancement, search/zero/end positioning. |
| 3. Nonempty unread suffix | Own one entry demand after `R`; deduplicate against the delivery-time window; join deliberately skipped history with an in-memory gap; reuse edge loading/retry presentation. | `R<C`, `R=C`, `R>C`, full overlap, numeric holes, disconnected ranges, no suffix messages, concurrent edge commits, unchanged storage/query contracts. |
| 4. Gap click and retirement | One older page adjacent to suffix; atomic prefix replacement; logical unmount cancellation; ordinary paging after retirement. | Reviewed `1..50 / 101..120` example, stable suffix DOM/position, geometry clamp, failure/retry, eviction, rebuild versus unmount, late result and sibling isolation. |
| 5. Edge and pin policy | Recheck both edges after completed mutations; single-flight; geometric pin and per-batch threshold. | Simultaneous top/bottom, synchronous delivery, short list, 3 versus 4 identities, album merge/overlap, no sticky unpin, explicit positioning unaffected. |
| 6. Integration and cleanup | Audit Web callers, remove superseded branches/comments/tests, update final implementation status. | Relevant Angular/browser suites and Playground cases; Web-side composer bridge assertions, with any unverified native-host presentation behavior reported separately. |

Checkpoints may need small prerequisite changes in the Web kernel or presentation
source. Review those dependencies rather than implementing multiple unreviewed
tracks in parallel. Transport and platform changes are excluded. No checkpoint
is marked complete by this documentation change.

## 11. Questions to settle at the relevant checkpoint

Do not guess at these cases while coding:

- The retained local batch itself spans multiple uncovered intervals: which
  segments are mounted and how are all seams represented without claiming
  continuity or reviving retired entry gaps?
- Confirm the no-network transition, if any, for an already-mounted search hit.
- Specify arrival accounting for own-send confirmation/optimistic replacement,
  and how overlapping concurrent results share the genuinely-new count.

The confirmed behavior above is fixed for implementation; these remaining cases
are review gates, not permission to introduce silent fallback policies.
