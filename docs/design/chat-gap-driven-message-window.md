# Gap-driven chat message windows

## Status and precedence

Status: implemented core design, including required `predestory()` retirement,
`CbLayoutScheduler` (`idle` / `balancing` / `animating` / `resizing` / `destroyed`),
single-gap balance admission (closest to viewport center when not pinned, or
bottom-most when `pinToBottom`), consumer-scoped tomb handoff without gap-to-gap
inheritance, dual-branch `scrollTop` / `transform` arrival displacement across
the viewport-height threshold, the shared tail activity row with immediate 3dot
removal, transient `POST /thread-feed` head `author` propagation, and
Web/Rust-aligned `evaluateEntrySeam` / `projectLocalInterval` / directional
`history-interval`. End-to-end device/visual acceptance remains a manual check.

This document is the current target contract for message-window entry, gap
loading, head notifications, positioning, animation, and item retirement. In
those areas it supersedes:

- [Chat history entry and message windows](chat-history-entry-and-window.md).
- [Server gaps and new-message arrival](chat-server-gap-and-arrival.md).
- [Window positioning scenarios](chat-window-positioning-scenarios.md).
- The skeleton, historical-edge, and measurement policies in
  [chat window loading and sending-task presentation](chat-window-loading-and-sending-tasks.md).
- The arrival, tail presentation, animation, and positioning policies in
  [tail sending cue](chat-tail-sending-cue.md), not task ownership or its non-history
  identity. Both 3dots occupy one special tail row and share appearance animation;
  removal is immediate.

Keep the durable range invariants in
[client message history synchronization](client-message-history-sync.md), the
conversation/composer ownership in
[chat surface binding lifecycle](chat-surface-binding-lifecycle.md), and the
[native runtime boundary](native-client-runtime-boundaries.md). Source observation
and directional query interfaces may change to implement this design. No new
persistent gap state, database reset, or schema migration is proposed.

Section 12 distinguishes implementation defaults from reviewed behavior. Those
defaults must not silently override the requirements in the preceding sections.

## 1. Core decisions

1. Normal window loading is gap-driven. A scroll checkpoint reads local storage
   only; mounted gaps own cancellable fill subscriptions and queries.
2. History spinners are presentations of gap items. Never replace a real message
   body with a spinner because a `hasMore` flag changed. Live-tail activity uses
   one special row with self/peer 3dots, not two historical messages. Its sending
   tasks and incoming-gap consumers retain independent ownership.
3. Project only the requested window, normally up to 50 items on each side of
   the entry coordinate, not every cached message in the conversation.
4. Keep special first-window loading and its whole-window skeleton when the
   read-position seam is not locally ready. Do not use an "all items are gaps"
   test as the sole readiness rule.
5. Retain head facts through both event-driven processing and mount-time checks.
   A head event carries coordinates, never an alternative message-body path.
6. Do not keep a permanent positioning component. Ordinary layout preservation
   chooses a temporary reference dynamically; explicit scrolling and bottom
   following do not pass through midpoint anchoring.
7. Scroll-offset animation is independent from the spinner animation batch.
   That batch includes the spinner fade and existing messages' canvas-relative
   layout movement. Never compensate the same scroll displacement twice.
8. On logical removal, call the custom `predestory()` method to stop business
   activity. It preserves the original Angular component and DOM until final
   `destroy()`. The spelling `predestory` is the reviewed API name.
9. Normal balance has no event-type parameter and commits at most one ready gap
   per pass. An explicit animation phase prohibits the next balance during 3dot
   appearance; events set dirty and retain data until the batch completes.
   Component-local album/selection effects do not hold this gate. No recursive drain.
10. Initial and special window loading bypass ordinary balance, reuse the tomb
    application/handoff helpers, and retain their explicit target positioning.
    Scroll animation remains interruptible independently of item replacement.
11. New message bodies have no entry fade/scale. Both 3dots share coordinated
    fade-in and canvas-relative movement of existing messages; disappearance is
    immediate. Keep interruptible scroll animation, remove spring/elastic effects,
    and correct post-removal position only for actual viewport blank space.
12. Pic/message components own internal size and selection animations, including
    rAF, cancellation, and completion. Commit final outer geometry once; local
    effects do not block balance. Sender-preview and overlapping-avatar state is
    bounded and ephemeral, never a substitute for gap/coverage evidence.

## 2. Coordinates, evidence, and gap identity

All history intervals use `(left, right]`. The coordinate `left` is excluded;
`right` is included. Message sequence zero is an origin, not a message item.
Keep these facts separate:

| Fact              | Meaning                                                                              |
| ----------------- | ------------------------------------------------------------------------------------ |
| `R`               | Effective last-read coordinate captured before entry read tracking begins.           |
| `E`               | Latest applicable known content head for this thread and account.                    |
| Visibility bounds | Server-authorized readable floor and ceiling, including cleared or retained history. |
| Coverage          | Committed scan evidence, including scans containing only deleted messages.           |
| Mounted window    | A bounded presentation; trimming does not erase durable history.                     |

### 2.1 One gap model, different evidence

| Gap kind             | Meaning                                                                                           | Loading owner                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Local temporary gap  | An interval not yet expanded in this window; its contents may already be cached or may need HTTP. | Cancellable source observation and bounded query.                      |
| `SERVER_PENDING`     | A durable server-recoverable history gap.                                                         | Interval SSE observation and a source/repository refresh after a wake. |
| `SERVER_UNAVAILABLE` | A durable unrecoverable history interval.                                                         | Render a terminal gap; do not start an ordinary recovery loop.         |

Position (`top`, `middle`, `bottom`), query status, and live-tail presentation are
not new durable range states. A local temporary gap is never persisted as a
message or as `SERVER_PENDING`.

Unknown local coverage and window omission are distinct evidence, even when
both use the same temporary-gap renderer. The repository decides whether a
query is a cache hit or needs transport; the renderer does not infer that from
spinner appearance. Known server classifications must survive local projection.

Normalize projected intervals: no empty or overlapping gaps; merge adjacent
compatible gaps without merging different server states or losing ownership.
Apply a returned page only to its actual committed scan. Preserve residual gaps
outside that scan. Reject stale expansion over newer covered/deleted evidence.

Do not infer gaps from nonconsecutive message IDs. A successfully scanned
interval containing only tombstoned messages is covered, not pending. Gaps do
not participate in message counts, read advancement, selection, quote targets,
album membership, or ordinary sender grouping.

### 2.2 Window edges

A top gap may extend to zero only when zero is the readable floor. Known server
gaps and visibility boundaries can stop or classify the edge earlier. A bottom
gap is bounded by the applicable known head, not an invented infinite sequence.
Trimming recreates omitted-window coverage through normal local projection.

Boundary evidence must be representable without tagging a real row: a page can
contain no messages yet prove progress or exhaustion. Local projection returns
its scan/window bounds and remaining boundary evidence alongside its items.
A gap is not an alias for the first or last message's identity.

The source may inspect range metadata outside the page to describe an edge, but
must not mount or shape all cached messages to produce a bounded window. Item
counts remain bounded; a wide gap is one projected item, not one item per seq.

No actual gap means no loading spinner. Shared head observation can remain
active without an empty or zero-width gap row.

## 3. Binding, initial entry, and navigation

### 3.1 Initialization order

Establish the internal conversation binding before constructing/activating its
source, requesting a mount, or subscribing to any replaying stream. Establish a
fresh window cancellation scope before window work. A source constructor must
not publish into an unbound or previous kernel.

Subscribe to thread-filtered head/tomb facts before reading their current
snapshots and starting the initial local query. Retain facts while a skeleton
or another window transaction prevents immediate application. Cancellation
scope identity, not thread ID alone, isolates an A-to-B-to-A rebind.

The reusable chat shell/kernel infrastructure and composer can survive a window
replacement. Mounted elements, source, subscriptions, outstanding requests, and
animation records cannot. Shell/composer readiness is separate from history
readiness and foreground permission.

### 3.2 Read-position seam

For `R > 0`, the older half includes `R`; the newer half excludes it. For example,
normal adjacent messages `100` and `101` supply the two sides of a request at
`R = 100`. `99` and `100` do not supply the newer half.

A local seed is ready for immediate presentation when neither side directly
adjacent to that seam is unresolved. More distant gaps inside the requested
window are displayed normally and do not force a skeleton. This is a coverage
predicate, not a literal requirement that rows `R` and `R + 1` both exist:

- Skip coordinates proven deleted when finding adjacent displayable content.
- A confirmed readable floor or ceiling satisfies an exhausted side.
- An unknown interval or pending server gap directly at the seam requires the
  special initial-loading path.
- `R = 0` has no older half; start at the readable beginning, never silently at
  the latest page.
- With `R = 0` and a known `E = 0`, present the empty conversation without a
  skeleton. An unknown head must not be treated as a known zero.
- Local read failure is an error, not evidence of empty history.

When the seam is not ready, keep the whole-window skeleton and use the existing
around-read intent (or start intent for zero) to establish a first window. It
may use HTTP and cancellable pending-gap observation. Preserve gap normalization
across repeated scans; do not resurrect a deleted-only residual interval.

Readiness does not require recovering the whole thread or all gaps. A definitive
empty/deleted-only result ends in the empty state; terminal unavailable coverage
ends in unavailable presentation; failures expose retry. A pending-only seam
continues loading until useful or terminal evidence arrives. A terminal gap
elsewhere must not hide an independently pending seam.

Position the actual read message when present, then enter normal rendering.
Do not invent a normal message at a missing/deleted coordinate. Preserve the
existing missing-read-target behavior: show returned surrounding content and
skip unavailable target-specific centering. Initial positioning is explicit,
not an ordinary midpoint-preservation transaction. Only after measurement and
head reconciliation may entry establish bottom following.

### 3.3 Explicit navigation

- A mounted message/album member needs only a target offset and scroll animation.
- An unmounted target replaces the message window, retains the conversation and
  composer, and uses the whole-window skeleton while loading around the target.
- Explicit `scrollToBottom` loads the latest window, using HTTP when necessary,
  if the actual latest content is not mounted. Reaching the geometric end of an
  arbitrary history window is not an equivalent operation.
- Capture the navigation's requested head. Later heads are retained as arrivals;
  do not restart the load forever while messages keep arriving. Consume them
  before losing the completed navigation intent.
- A target still inside a pending gap is not yet proven missing. A definitive
  deletion/unavailable result may finish the navigation with a missing result.

### 3.4 Initial and special loading bypass balance

Initial loading and special whole-window loads commit through their existing
explicit-positioning path, not ordinary balance. For entry/around loading, center
the starting target where possible; zero, missing targets, and explicit latest
navigation retain their distinct boundary/positioning rules above.

Before positioning or publishing visibility, reuse the same tomb helpers as
ordinary balance: suppress deleted incoming bodies, replace already displayed
messages when applicable, notify current gap/read consumers that can still hold
pre-tomb data, and clear only facts whose handling/handoff is complete. Newly
created gaps read the already-committed database and do not inherit tomb lists.
While the load is pending, its consumer must retain relevant tombs even if no
gap is mounted yet. New head/tomb facts arriving during loading are not discarded.

Ordinary balance remains prohibited until this initial commit completes.
Pending ready states/dirty requests then resume through the normal scheduler. This is separate from the special live-tail
spinner's local appearance/disappearance path in section 5.

## 4. Local checkpoints, gap queries, and replacement admission

### 4.1 Local-only expansion

Normal scroll checkpoints request bounded older/newer projections from local
storage. They must not bootstrap HTTP bounds, fetch messages, or wait for remote
recovery. They return cached messages, projected gaps, and explicit bounds.

Render the batch, measure it, apply the appropriate positioning path, and check
truncation in a single transaction. New gaps start their own fill lifecycle.
Source cache traversal must describe unknown coverage rather than simply stop
with a `hasMore` boolean and hide the missing interval.

### 4.2 Subscribe on mount; queries do not own DOM replacement

A mounted local gap registers a cancellable source observer before its initial
query. A mounted recoverable server gap registers interval SSE observation. The
server first registers its committed-event listener, authorizes the interval,
and emits an initial wake; the client then queries through the source. The
server also schedules recoverable federation history work. This initial wake
already exists and must not be lost in the refactor.

Register-before-read prevents a commit during initial observation from being
missed. Each gap has at most one in-flight query. Wake events coalesce; a local
commit of the query's own page must not cause an endless query/commit loop.

The query owns transport and commit coordination, not permission to mutate the
window. On completion, the gap component stores its ready page (items plus actual
committed scan bounds) and synchronously calls parameterless `requestBalance()`.
There is no separate gap-ready command type, revision counter, or queue of stale
DOM splice commands. The owning mounted instance and cancellation scope identify
the consumer. The kernel reads and takes the component's ready result at commit.

Before consuming a ready page, check:

1. The binding/window and logical gap consumer are still current.
2. The result's bounds still apply to the current interval projection.
3. The gap is in the replacement region, or qualifies for active live-tail follow.
4. No initialization, layout commit, or spinner animation prohibits balance.

A result waiting only for the animation gate stays ready in its component. Use
that result directly when admitted; do not unconditionally re-query it. Apply
all tombs handed to the component before returning its items to the kernel.
Do not start a sibling query that overwrites an unconsumed ready scan; coalesce
later availability until the ready result is consumed or discarded.

If outside the region at admission, retain the committed database result but
release the ready page without changing the window. On later region entry,
query the source again; it should normally hit local storage. Pre-destruction
clears ready state and cancels the consumer. New instances cannot inherit an old
instance's queued callbacks, even at the same coordinates.

Subscription readiness never mounts data by itself. It must, however, wake a
previously admitted load waiting for readiness. Successful commit and page
content are not the same thing: empty pages can advance coverage.

### 4.3 Direction

Direction is selected for each query, not once for the entire subscription:

| Mode/location                       | Query from                                            |
| ----------------------------------- | ----------------------------------------------------- |
| `pinToBottom`                       | Gap bottom (newer seq end), toward older coordinates. |
| `pinToHead`                         | Gap top (older seq end), toward newer coordinates.    |
| Normal, gap above viewport midpoint | Gap bottom.                                           |
| Normal, gap below viewport midpoint | Gap top.                                              |

Use current committed viewport geometry when a local query starts or an SSE
wake is consumed. Do not rewrite an in-flight request after the user scrolls.
Recompute admission and positioning at delivery time. Implement `pinToHead` as
a callable capability without introducing a production UI caller in this work.

The repository/Rust history owner performs the bounded query and validates scan
coordinates. A gap component never sends raw HTTP or reproduces the range reducer.

### 4.4 Parameterless, nonrecursive balance scheduling

`requestBalance()` is synchronous: set dirty and arrange a pass when permitted.
It does not await I/O or accept an event-type parameter. Events retain their
facts with their owner: ready pages on gaps, tombs in the chatbox pending map,
heads on the window coordinator, and pending local reads/height changes on their
existing consumers. Dirty is a wake flag, not a substitute for that data.

Use an explicit layout phase (conceptually idle, balancing, animating) separate
from initialization/window lifetime. A 3dot appearance batch includes existing
messages' coordinated canvas movement. Album and selection effects stay component-local.
Do not count per-element animation starts and ends to decide whether balance is
allowed. An immediate 3dot removal is a synchronous gated layout commit, not an
animation phase.

Keep a generic finite animation timer and completion mechanism. Arm it for actual
cross-message appearance work, never as a delay for component-local animation,
message rendering, or 3dot removal.
Begin the gate before the first animation frame; both normal completion and timer
fallback finish final presentation/retirement exactly once before reopening it.
Teardown cancels the timer, and late completions cannot affect a new window.
A paused background rAF or missing animation event must not strand the gate.

One permitted pass:

1. Clear the dirty flag for this pass and capture its starting geometry using
   the appropriate ordinary, explicit-scroll, or pinned path.
2. Check changed heights, apply pending mounted tombs and hand relevant facts to
   current gap/read consumers that may hold stale data, then perform appropriate
   initial truncation.
3. Inspect ready gap components, with the bottom spinner checked first. Select
   at most one eligible gap to replace. Pending I/O is not a ready result and
   must not stall other ready gaps.
4. Take that gap's tomb-filtered page, commit its bounded replacement, measure,
   restore offset, and truncate against final geometry. New residual gaps read
   committed storage; they do not inherit tomb lists or the previous consumer's
   unprocessed results. Preserve temporary-reference/canvas-origin data before
   removing entries. Local-only checkpoint work shares this gate.
5. Publish tomb-safe visibility only after the commit. Message bodies appear
   immediately; a 3dot appearance batch owns the explicit animation phase until
   completion. Local pic/selection effects and 3dot removal do not enter that phase.
6. Retain dirty for other actionable ready gaps or events that arrived during
   the pass. On animation completion, return to idle and schedule one further
   pass when dirty. Without an animation, schedule a later pass rather than
   recursing synchronously.

A pass may initiate async work, but neither an unresolved request nor a gap's
mere presence warrants a busy loop. Ready gaps rejected by region checks must
not continually dirty the scheduler without a relevant change. Never consume
all ready gaps in a synchronous recursive drain. Network subscriptions may run
concurrently; the single-gap limit is a DOM replacement budget, not a requirement
that only one gap subscription exists.

A synchronous replacement commit is non-reentrant. An admitted 3dot appearance
batch plays to completion without being interrupted by another ordinary balance
or user scroll. User scroll still changes the viewport and can cancel the independent
offset animation; it sets dirty for later balancing. Cancelling or completing
scroll alone must not release the spinner gate. The animation owner issues one
completion, not one balance per element.
Reduced motion/no-effect batches finish the phase without waiting for a missing
animation event. Binding teardown cancels and disposes everything immediately;
late animation completions must not unlock a successor window.

### 4.5 Tomb handling and handoff

The chatbox retains committed tomb facts in a thread-scoped pending map. A tomb
notification first stores the fact, then requests balance. While balance is
prohibited, only data/dirty are updated; do not replace mounted rows directly
from the subscription callback.

The shared tomb helpers used by normal balance and special loading must:

- Replace matching already displayed messages with the appropriate tomb notice,
  including album split/removal behavior.
- Pass each relevant tomb list to current gap components whose `(left, right]`
  contains the seq. Include both querying gaps and components already holding
  ready items: their bodies may have been read before the tomb was committed.
- Have each current gap apply its retained tombs before yielding ready items;
  an incoming deleted body that was never displayed is suppressed, not newly
  rendered as a historical tomb row. Keep protection while that consumer can
  still publish pre-tomb data; release it when the consumer retires.
- Do not transfer tomb lists to newly created residual, split, or merged gaps.
  The notification describes a durable commit; those new consumers read the
  current database. They must not adopt an old consumer's unfiltered page or
  in-flight request. Reusing an existing consumer keeps its current protection,
  rather than treating it as a fresh read.
- Protect initial/special loads and local checkpoint reads that may return stale
  bodies even when there is no mounted gap to receive a fact. Those consumers
  receive the handoff too, or the central entry remains until safe handling.

Clear a central map entry only after its currently mounted effect and every
still-live stale-result consumer have been handled or received the fact. Clear
only the captured facts, not newly received replacements/notifications in a
blanket `clear()`. Lack of in-flight spinner HTTP is not a safe cleanup condition:
a ready page or initial/local read may still contain a pre-tomb body. Later reads
are protected by durable tomb suppression. Scope revocation cancels old consumers
before clearing their transient facts on thread close/switch.

This is transient stale-result protection, not another durable deletion index.
It bounds central retention by handoff to current consumers, without gap-to-gap
inheritance, retaining every tomb until thread close, or assuming synchronous
balance can wait for future I/O.

## 5. Content-head notifications and special live-tail gaps

### 5.1 Two entrances to one reconciliation operation

Use an RxJS head stream analogous to committed tomb delivery. Filter by thread
and valid window scope. Retain the greatest applicable unconsumed `E` inside the
chat window owner; message bodies still come from the source.

Run the same reconciliation operation:

- proactively when a head notification arrives, even without a mount; and
- at every completed mount transaction, including first-window completion.

A skeleton retains the fact without mounting into a partial window. A transaction
consumes only the head it captured, not a larger one that arrived meanwhile.
Repeated notifications are idempotent. Re-read/reproject the current relevant
range; do not incrementally append arbitrary overlapping gaps to every event.

### 5.2 Incoming gaps and the shared tail row

Represent post-opening incoming activity next to the previously latest mounted
message using a special tail row. It contains self-side and peer-side three-dot
bubbles (3dots) on the same horizontal row, with both avatar positions on that
row. It is not a real message, read target, or album member. Its gap consumer and
sending-task presentation keep their distinct owners; neither spinner owns the
other's business state. Ordinary historical gaps keep their usual presentation.

Incoming sender previews select the relevant side; an incoming self-authored
message can keep the self-side 3dot present even after all local tasks finish.
Peer-side activity means pending message loading, not remote typing. Do not invent
a sender from a numeric head event when preview identity is not available.

If the prior latest message is not mounted at the tail, retain `E` and sender facts
without inserting the special row beside unrelated history. Repeated heads
reconcile one row, never one new row per event. Two visible sides share the same
measured row height rather than adding two vertical rows. Adding a second side
must not move existing messages by a fictitious second row height.

| Query outcome                | Tail behavior                                                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Messages                     | Render immediately or absorb into an album; consume applicable sender previews only after kernel commit.            |
| Server gap                   | Preserve unresolved coverage in the returned gap and its recovery/terminal presentation.                            |
| Successful deleted-only scan | Consume covered previews without inventing bodies; remove unneeded 3dots immediately.                               |
| HTTP/network failure         | Remove failed loading presentation immediately and report once; retain unresolved facts without a tight retry loop. |
| Cancellation                 | Release the consumer; no network-error toast.                                                                       |

Appearance and removal are isolated layout operations: no checkpoint expansion
or unrelated trim merely because the tail changed. Appearance owns the finite
animation gate; removal is immediate when admitted and does not start a timer.
During an existing appearance batch, retain desired visibility and apply
it after the gate opens; cancellation and window teardown remain immediate.
Returned pages use normal one-gap balance. Suppress the corresponding programmatic
scroll checkpoint, not the user's next real scroll.

A failed request does not establish coverage. Keep head/interval evidence and do
not recreate failed loading presentation from an unchanged head on every pass.
A later eligible checkpoint, explicit retry/navigation, or new availability can
rearm it. Tail removal always uses the blank-space rule in section 8, regardless
of whether a page was empty, added rows, or merged into an existing album.

### 5.3 Head author and bounded ownership

Extend the existing `POST /thread-feed` conversation snapshot with
`author: { account, namespaceId }`. It is required and non-null when
`messageEndSeq > 0`; when `messageEndSeq === 0`, omit `author` because no message
exists. The outer `messageEndSeq` is its message coordinate; do not repeat seq
or call this identity a preview. The
author belongs to that exact head message, including self-authored and already-
read messages, not an independently selected older message. Keep the existing
unread-oriented `previews` list and its notification semantics unchanged. There
is no separate author endpoint or per-window author HTTP request.

Read head author identity in the same read-only snapshot as the feed item.
Enforce the viewer's visibility and deletion rules without conflating erased
content with author identity. Never substitute an older message's author or use
null as a fallback for system accounts or missing bodies. The zero-head omission
is the only no-author case; both worker and Rust must validate this invariant
before committing the snapshot and feed cursor.

Use the existing namespace-scoped account identity, not a domain string or a
server-guessed avatar address. Frontend profile/avatar resolution stays on the
existing profile pipeline, with its established namespace context and revision
evidence; do not invent revisions or equate namespaces from different publishers.
Return no body, summary, profile document, or avatar payload in the new field.
System-account identity is returned normally. The frontend ignores it for
tail sender/avatar presentation, without discarding the content head or suppressing
normal loading, coverage, or rendering of the system message.

Keep the current account-owned synchronization path: browser database worker or
Rust drains `thread-feed`, validates `(messageEndSeq, author)` and commits the
snapshot plus its feed cursor without persisting `author` in IndexedDB or SQLite,
then publishes the existing local feed-committed notification carrying the
transient `author` from that committed page. The chatbox's bounded queue of
observed pending authors remains ephemeral. Closing a window does not cancel
account feed work; Native HTTP, commit, and notification ownership remains in Rust.

Forward head and author together from committed thread state through
`ThreadStoreService`, `MessageRepository`, and the source to the current window.
The kernel receives facts, not pushed bodies or DOM commands. Reject stale feed
snapshots using the existing `threadFeedId`, and reject revoked session/window
delivery. Use the existing feed coordinate to order complete snapshots; the head
alone is not a snapshot version. Deduplicate observed pending author entries by
the outer message coordinate, and retain unresolved head/coverage independently.

Cache observed head/account/namespace entries in the chatbox: retain at most the
newest 100 self entries and the newest 100 non-self entries combined across all
group members. Trim oldest seqs; this is not a per-member allowance. Preserve
unconsumed head/coverage evidence independently of this bounded presentation cache.
A latest-only field cannot reconstruct intervening senders skipped by coalesced
feed updates. The avatars represent observed pending senders, not a complete count.

Consume previews only after the kernel commits their message or authoritative
covered/deleted scan. Receiving a head, writing to the local DB, or holding a ready
page behind the animation gate is not consumption. Album absorption consumes its
new member seqs, not just the album head. Local task completion alone cannot hide
a side with unconsumed incoming previews; the shared row remains while either side
has relevant work. Scope revocation releases this ephemeral state.

### 5.4 Grouping, overlapping avatars, and header biography

Apply ordinary sender grouping independently to the two sides of the special row,
including the self-avatar preference. The normal peer avatar is selected from the
oldest pending observed non-self sender and displayed only when grouping requires
it. In groups, show other observed pending senders as overlapping avatars to the
right of the peer 3dot. Deduplicate by namespace-scoped account identity, not
domain strings, and exclude system accounts from this presentation. Show at most
three overlap avatars, followed by `…` for additional observed identities. Do not
use `+N`, since latest-only previews cannot supply a reliable participant count.
Avatar additions/departures may fade without spring motion; reserve fixed height.
Removing the whole 3dot/row remains immediate, without waiting for avatar fades.

While valid `pinToBottom` is held, preserve the header biography instead of
switching it to the task face, even if the 3dots are currently hidden. Header
suppression must therefore follow kernel pin intent, not just tail visibility.
Other composer/task-header rules remain outside this history change.

## 6. Bottom-follow state and the large-arrival exception

Bottom following is a window intent, not a test of `scrollTop` alone.

- New entry into follow requires both latest-window eligibility and bottommost
  element contact. Latest displayable content must be mounted, coverage must
  connect it to the applicable known head, and no ordinary unresolved tail gap
  may remain beyond it. Deleted head positions are satisfied by coverage, not
  a nonexistent row with `seq === E`.
- Test contact using the actual bottommost rendered element in the committed
  layout: the final message or the special shared 3dot row, whichever is last.
  Include trailing presentation and the existing composer reserve in the effective
  bottom target. The newest message's own bottom touching the viewport is not
  sufficient when a 3dot still extends below it. Neither indicator alone proves
  latest-window eligibility.
- A historical window does not enter follow merely because its local bottom is
  visible; `scrollToBottom` provides explicit latest navigation.
- An established follow survives either 3dot appearing/disappearing and ordinary
  small arrival replacement. Both indicators contribute to bottom geometry;
  a transition frame is not user intent to release pin.
- User upward scrolling cancels follow; relevant user scroll intent also
  interrupts an in-flight offset animation. Programmatic scroll notifications,
  pointer contact without scrolling, and spinner geometry changes must not be
  mistaken for an upward user scroll. For an already established live-tail
  context, returning to the actual bottommost tail element, including either
  3dot when present, can restore follow; this exception does not make arbitrary
  historical gap bottoms latest boundaries.
- A large measured arrival is the other explicit exit from follow. Preserve the
  pre-arrival visual origin and do not start scrolling to the new bottom. Clear
  follow so a later resize cannot undo the decision.

Retain the existing 70%-of-viewport growth limit and its short arrival aggregation
window. Count genuinely new message height, including new album cells, not
spinner/reserve churn, duplicate pages, tombs, or a remount of cached history.
Do not bypass the limit by splitting one arriving burst into small deliveries.
Explicit navigation and first-window positioning are not arrival batches.

For pinned mutation, preserve the old visual origin using offset/canvas geometry,
commit the new layout, then start the offset animation if follow is admitted.
Do not first snap to the new bottom, and do not capture a midpoint anchor "just
in case" the large-arrival rule declines follow.

## 7. Positioning and layout transactions

### 7.1 Ordinary reading preservation

There is no persistent anchor-component field. Before an ordinary layout change:

1. Read the viewport midpoint from committed kernel geometry.
2. Select the normal retained element containing/nearest that point.
3. If the point lies inside a gap or the replaced region crosses it, select the
   first retained normal element after that region; fall back to the preceding
   normal element, then an offset if none exists.
4. Capture that element's own current viewport displacement. Do not assign a
   removed element's displacement to its successor.
5. Keep this temporary reference fixed through this synchronous transaction.

After mutation, measurement, and any ordinary truncation, derive the offset
from the retained element's new canvas position and its captured displacement.
Include short-list bottom alignment and legal scroll-range clamping. Resolve
album members through stable message identity, not a destroyed component ref.

A gap's current geometry is computed dynamically for loading/admission; it never
becomes a stable message anchor. Do not derive compensation by adding unrelated
"above the viewport" adjustments in several helpers.

### 7.2 Explicit scroll and pinned mutation

These are separate paths, not additional anchor corrections:

- Explicit scroll has a target offset and plays the scroll animation after any
  required loading/mount/measurement.
- Pinned mutation restores the old visual origin, then follows the new bottom
  through offset animation if the growth policy allows it.

Neither path computes or restores a midpoint reference. Preserve any translation
of canvas origin caused by truncation so the starting visual position remains
continuous without secretly routing through midpoint anchoring.

### 7.3 Common geometry rules

All height-affecting renders share the geometry and tomb helpers: page mount,
gap replacement, tomb replacement, album changes, message content resize, and
relevant viewport/composer reflow. Normal changes are admitted by the explicit
balance phase gate; callbacks must not bypass it to mutate mounted contents.
Initial/special loading uses the independent explicit-positioning path in
section 3.4. Paint-only changes need no new measurement. An ordinary transaction
checks truncation against final geometry; special spinner transactions in
section 5 explicitly skip balance and truncation. Pic and selection components
commit final outer dimensions through ordinary measurement; their internal
animation lifecycle is not part of kernel admission.

Use integer CSS heights/line heights and `offsetHeight` measurements. Transforms
are paint-only; never replace measurements with transformed bounding rectangles.
Capture new layout in batches. Spinner frames are paint-only. Component-local
frames operate within committed outer dimensions, without kernel remeasurement.
A frame callback must not cause an unbounded cycle of mount, immediate source
delivery, and trim.

## 8. Scroll, tail appearance, and album layout animation

Messages and new album cells render immediately. There is no standalone message
entry effect. Existing messages' canvas-relative movement during spinner
appearance belongs to the spinner animation batch. 3dot removal is immediate. The virtual canvas
is a coordinate model, not an HTML `<canvas>` requirement; keep one authoritative
scroll offset.

### 8.1 Scroll-offset animation

Animate `offset(current) -> offset(target)`. Explicit scroll and bottom follow
move the viewport through the entire canvas. Do not include this displacement
in the spinner batch's per-element canvas movement. User input interrupts
programmatic scrolling. An ordinary explicit message jump does not acquire
bottom-follow ownership.

### 8.2 Shared 3dot appearance

Use the same rAF appearance contract for both sides of the shared tail row. The
component owns its fade-in; the kernel coordinates cross-message displacement
and the finite batch gate. Capture old canvas positions, commit and measure the
actual shared row height, then move retained messages upward to their resulting
canvas positions while 3dots fade in. Existing messages remain opaque. Use
non-overshooting motion, not spring/elastic easing. A second side appearing in
an already occupied row need not add height or move messages.

For a message participating in this spinner batch:

```text
screenY = layoutCanvasY + spinnerLayoutDeltaY - scrollOffset
```

Initialize `spinnerLayoutDeltaY` from the old presented canvas position minus the
new layout position, including any canvas-origin change, then animate it to zero.
Do not include scroll displacement in this delta. If an element has no canvas
layout change, its delta is zero. Capture and measure at transaction boundaries;
per-frame work updates presentation without remeasuring layout. Keep integer
`offsetHeight` geometry; the visual transform may be fractional.

Appearance prohibits ordinary balance from the first-frame wait until fade-in
and all coordinated message movement finish. They share one finite timer and
completion owner, not per-message locks. Appearance does not itself request
balance. The repeating 3dot pulse is paint-only and does not extend this batch.
Removal has no fade or reverse displacement animation.

Scroll and this spinner batch share rAF scheduling but have independent
completion ownership. Interrupting or retargeting scroll cannot cancel either
the spinner fade or its canvas-relative message movement, or release the gate.
New facts/results stay with their owners and set dirty while the gate is held.

### 8.3 Finite timer and completion

The common animation mechanism owns one finite timer and one idempotent finish
operation per admitted animation batch, not a counter of individual effects.
Normal completion and timer fallback converge on the same finalization: apply
the spinner's final presentation and all retained messages' final canvas positions,
clear their temporary deltas, return to idle, and
schedule one later balance only if dirty. The timer must cover a suspended first rAF as
well as missing completion events. Messages rendered without a spinner effect
must not start an empty animation timer or incur an artificial delay.

Reduced motion applies final canvas positions and spinner presentation immediately
or with a minimal fade, then releases the phase. Unbind/window replacement cancels frames and timers and
disposes immediately; stale callbacks cannot unlock the successor window.

### 8.4 Immediate removal and blank-space correction

When admitted, remove an unneeded 3dot immediately, measure the resulting shared
row/message geometry, and correct position only if actual bottom blank space is
exposed. Do not infer correction from whether a page contained new messages.
This covers empty/deleted scans, failed loading, and absorption into an existing
album alike. If the other side keeps the row height unchanged and no blank space
appears, do not move the viewport.

Use the legal offset range derived from committed content height, viewport, and
composer reserve. Clamp an offset beyond the new maximum; preserve a valid offset
when there is no blank space. Short content remains bottom-aligned. Correction
must not create a spring bounce, reacquire lost follow, or bypass the large-arrival
exception. There is no removal timer or unconditional reverse row animation.

### 8.5 Component-owned pic and selection effects

Pic components own internal cell width/height interpolation, positions required
by rearrangement, rAF, cancellation/retargeting, and completion. Message components
likewise own selection background, checkmark, and content-inset transitions.
These effects do not acquire the kernel animation gate or require kernel completion.
Avatar fades and height-neutral task effects follow the same ownership rule.

Commit the final outer message/album size once through normal kernel measurement,
then animate the internal elements within that stable allocation. Clip visual
surfaces as needed so they cannot enlarge scroll extent; keep overlays usable
within their intended component boundary. Do not animate a thumbnail's decoded
intrinsic size into the list geometry. All animated height-contributing values
remain integer CSS pixels; do not use fractional CSS height transitions or whole-
image scaling as a substitute. Horizontal dimensions may be fractional.

If an actual external height change occurs, report it through the ordinary height
contract. That does not transfer animation control to the kernel. Pre-destruction
cancels local rAF/effects immediately, and callbacks cannot publish into a rebuilt
or retired component. Local effects use no spring/elastic easing.

## 9. `predestory()` and real-DOM retirement

### 9.1 Required lifecycle

```text
active
  -> predestory()                    // immediate business cancellation
  -> destroy()                      // final Angular and DOM disposal, no exit delay
```

The item adapter exposes the custom method to the kernel and propagates it into
its component/child resource scopes. It is not an Angular hook and must not be
implemented by manually invoking `ngOnDestroy()`.

`predestory()` must be synchronous and idempotent:

- Mark the element inactive before cancellation can synchronously emit callbacks.
- Cancel owned HTTP, gap/source subscriptions, retries, timers, profile/quote
  consumers, observers, interaction handlers, and queued result publication.
- Stop component/child business updates, including work otherwise relying only
  on `takeUntilDestroyed()`; that operator alone is too late for this contract.
- Detach only this consumer from shared work; do not cancel account feed drains,
  sibling windows, sending tasks, or repository-owned admitted transactions.
- Leave original DOM and presentation resources intact until final destruction.

Do not call `ApplicationRef.detachView()` or `ComponentRef.destroy()` during
`predestory()`: the current Angular attachment path removes DOM on detach.
Change-detector detachment can freeze rendering but is not resource cancellation.
Detaching the parent's change detector also does not cancel independently attached
children.

Component and adapter cleanup must distinguish business subscriptions from
presentation leases. For example, stop observing avatar changes immediately but
retain the displayed image URL lease until final destruction. Keep Angular
styles alive until then. Stop media business/playback activity during
pre-destruction. Do not clone DOM or reconstruct components to emulate retention.

After pre-destruction, remove the logical entry from mounted geometry/read and
interaction ownership. Message and 3dot removal proceed directly to `destroy()`.
No spinner exit layer or delayed destruction is required. A departing overlap
avatar retained briefly for its own fade is paint-only, has fixed geometry, and
must not delay whole-row removal or retain any query/subscription.

`destroy()` calls `predestory()` as a fallback, then detaches/destroys every owned
Angular view, releases retained presentation leases, removes the DOM, and removes
animation bookkeeping. It is also idempotent. Finish destruction even when one
cleanup action fails; no sibling resource may leak because an earlier hook threw.

### 9.2 Close, switch, and replacement

On thread unbind/window replacement, revoke publication first, cancel window
work, and immediately pre-destroy and destroy all active and retiring elements.
Cancel scroll/spinner animation frames and timers, clear coordinated canvas
deltas, and remove retained DOM; do not wait for fades or `animationend`. Destroy the source after releasing its consumers. A terminal
chatbox disposal additionally destroys reusable kernel infrastructure.

A retiring renderer cannot be updated or returned to the active state. Dispose
any old retained renderer before mounting a fresh instance of the same logical
identity; cancelled renderer work must never be revived.

## 10. Ownership and transport constraints

| Owner                   | Responsibility                                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Chat window coordinator | Bind-first ordering, frozen entry/read facts, skeleton/navigation, retained head facts, presentation errors.        |
| Generic kernel          | Mounted geometry, dynamic positioning, replacement admission, truncation, scroll/spinner animation, item lifecycle. |
| Gap item/controller     | Mount-owned subscription/query consumer, direction intent from kernel geometry, delivery proposal, cancellation.    |
| Presentation source     | Typed local projection/fill operations and conversion to messages/gaps; no direct DOM writes.                       |
| Browser repository      | IDB projection, bounded HTTP, canonical commits, commit notifications and consumer cancellation.                    |
| Rust history owner      | Native SQLite/HTTP/interval observation, request lifetime, retries, session checks and commit publication.          |
| Platform adapters       | OS/IPC adaptation only; no parallel history or follow policy.                                                       |

The kernel does not render network toasts. The browser HTTP interceptor already
surfaces network/server failures; native transport needs equivalent host-facing
error delivery without duplicating toasts. Failure/cancellation outcomes must
still reach the consumer/kernel where needed to end loading presentation.

Keep server listener-before-initial-wake ordering, visibility authorization, and
scan clipping. Browser and Rust interval queries currently start from the newer
end; both need the directional contract, not only the TypeScript wrapper.

The current interval service has a process-wide cap of 100 subscriptions with
oldest-first eviction. Unified gaps must not silently become permanently inert
on eviction. Define bounded shared observation/recovery and test capacity behavior;
do not introduce a tight reconnect/evict loop. Terminal gaps require no recovery
subscription. A source read result is not itself a database mutation notification.

## 11. Migration boundary

Remove old message-to-spinner presentation selection, special top/bottom network
demand ownership, source-driven direct live mounts, and duplicated gap/body
loading routes once their replacement is integrated. Keep local-only checkpoint
reads and the independent composer reserve; the reserve is not a history spinner.
Migrate all kernel clients, including forwarded snapshots and Playground mocks,
without making finite snapshots invent network or live-tail subscriptions.

Do not change unread eligibility, durable tomb precedence, send/outbox ownership,
message identity, or federation authorization to simplify UI code. Native changes
remain in Rust with thin IPC adapters. Source/configuration comments explain
behavior directly and must not link to these documentation files.

## 12. Implementation defaults and validation gates

No additional product decision is needed to start implementation. The following
are explicit defaults or engineering gates, not claims of completed behavior:

- Start replacement-region admission with the existing viewport buffer (currently
  1000px above/below), expressed as gap/region intersection. This generalizes the
  old edge checks; validate wide gaps, short lists, and simultaneous deliveries.
- When the viewport midpoint lies within a gap, use the newer-side retained
  reference and query from the gap bottom as a deterministic normal-mode tie-break.
- Keep the existing 70% growth limit and 120ms arrival aggregation interval while
  migrating the follow policy. Prevent pagination from resetting burst accounting.
- Keep direction/query budgets finite and retain the current 50-item backend
  page limit. Exact TypeScript/Rust interface names other than `predestory()` are
  implementation choices; no compatibility shim may preserve a second loader.
- Centralize scroll timing, spinner fade rate, coordinated canvas-movement speed,
  and the finite animation timer. Validate them in browser tests without claiming
  operator-approved durations.
- Prove child pre-destruction, presentation-resource cleanup, and immediate Angular
  final disposal in focused browser tests. Verify local effect cancellation and
  overlap-avatar clipping separately; no message/spinner exit layer is required.
- Settle the concrete interval-sharing/eviction strategy with a capacity test
  before removing the old subscription route. Report protocol or deployment
  implications explicitly if that requires a server change.

Required regression cases and the implementation sequence are in the development
plan. This document does not establish browser, PostgreSQL, Rust, or device test
results.
