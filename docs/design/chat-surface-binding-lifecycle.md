# Chat surface binding lifecycle

Status: implementation in progress. Kernel and composer reuse, browser/native
history cancellation, explicit surface binding, and window subscription ownership
are implemented. Native history cancellation remains per request; global host
sweeps are intentionally omitted. Device validation remains open.

## Message window implementation

A conversation binding and its foreground permission outlive individual message
windows. A mounted-target jump only scrolls the current window. An off-window jump
releases the previous window's result subscriptions, unbinds the kernel, destroys
the source, and creates a new source on the same kernel. Both the message thread
and forwarded-snapshot viewer supply the window replacement callback; the kernel
no longer has an in-place `openAround` fallback.

The kernel has no generation counter. Initialization and fill are Observable
chains, backfill has an explicit subscription, and each edge owns one single-flight
subscription. Mounting, measurement, position updates, optimistic reconciliation,
and edge completion run inside delivery rather than after an awaited demand.
Unbind unsubscribes these operations before aborting the source signal. The public
Promise methods only report completion to callers and settle on cancellation;
callers unsubscribe their own result delivery before replacing a window.

A missing target or failed initialization leaves the kernel unavailable for edge
loading. The message thread presents missing/error actions instead of silently
loading the newest page. An explicit initial unread-anchor fallback remains
supported. Source teardown can cancel owned transport, but subscription teardown
does not roll back cache commits already admitted by the account owner.

Consolidated validation: 453 tests across 37 suites covering kernel, source,
thread, host, composer, cancellation helpers, native history transport, repository,
and database passed together. A subsequent full Web unit run passed all 2011
tests across 244 suites. All 24 Playground browser tests passed. Browser coverage includes missing/latest,
failed/retry, superseded initialization, and preservation of composer draft,
instance, kernel, conversation binding, and foreground permission. These checks
do not establish Android device behavior or cross-WebView IPC routing safety.


## Decision

Separate preparation of reusable UI infrastructure from binding a conversation.
The chatbox and composer belong to one chat-surface binding lifecycle. A mounted
surface can be fully prepared without conversation parameters, message items,
conversation subscriptions, or an active composer context.

Returning a surface to that prepared state must cancel its binding-owned work,
unmount all message items, and remove all conversation state. It must not destroy
and rebuild reusable infrastructure on every conversation switch.

Do not implement this as additional guards layered on the existing collection of
initialization flags. Replace the overlapping lifecycle paths and remove their
obsolete state after migrating callers and tests.

## Current implementation and motivation

Relevant implementation:

- [ChatPaneComponent](../../web/src/app/components/desktop/chat-pane/chat-pane.component.ts)
  coordinates two resident A/B slots and foreground promotion.
- [MessageThreadComponent](../../web/src/app/components/message-thread/friend-message.component.ts)
  currently mixes input synchronization, kernel initialization, readiness,
  composer activation, and teardown.
- [ChatBoxScroller](../../web/src/app/lib/chat-box/chat-box-scroller.ts) owns the
  virtual message list, not the composer. Its constructor currently requires a
  source, installs observers/listeners, and creates the tail cap.
- [HttpItemSource](../../web/src/app/components/message-thread/http-item-source.ts)
  currently requires a conversation and starts subscriptions in its constructor.
- [ChatInputComponent](../../web/src/app/lib/chat-input/chat-input.component.ts)
  is normally reused per A/B slot, not recreated for every conversation. Template
  branches can destroy it for blocked/read-only/paused states.
- Android uses one Activity-local native composer controller, with an active
  context owner, instead of the Web ChatInput instances.

The observed bug is an ownership violation: the host idles a resident kernel,
clearing its current thread marker, but a later reactive input update runs the
initialization effect and recreates that kernel. Unsubscribing the old source
alone cannot prevent a new source from being constructed.

A regression using Angular effects and the production synchronization method,
without Playground services, reproduces this on conversation metadata updates.
Removing the interim idle guard causes initialization to occur twice rather than
once. This establishes a shared-component failure path, not a claim that all
native/backend environments have been exercised.

## Lifecycle model

The shared contract is a synchronous, replayable RxJS state stream. Kernel and
composer adapters subscribe to it; the host does not separately invoke their
unbind cleanup. Angular signals are a projection for templates, not the delivery
mechanism for cancellation.

| Shared state | Meaning                                                                                       |
| ------------ | --------------------------------------------------------------------------------------------- |
| Unbound      | No conversation ownership. Reusable infrastructure may be prepared without parameters.        |
| Bound        | Contains a binding scope (thread ID, cancellation signal) and explicit foreground permission. |
| Destroyed    | Terminal component disposal.                                                                  |

Loading and presentation outcomes (history, empty, blocked, error) are internal
message-surface state, not shared lifecycle events. The message surface reports
presentation readiness for its binding; foreground permission is granted only
when presentation and host navigation both allow it. Composer restores its draft
on binding without depending on history-load internals.

Unbound revokes old publication rights and aborts before synchronously notifying
subscribers. Do not introduce scheduling, debounce, or an Angular-effect delay on
this path. Source retains its per-binding construction/cancellation mechanism;
picker ownership fields and account-owned upload tasks are not migrated to this
stream.

Initial-load success/failure and send capability are presentation data within a
binding, not substitutes for infrastructure readiness. A blocked conversation can
be presented without creating a history source. A read-only conversation can show
history without activating a composer. An initial-load failure must remain
retryable without pretending that the component failed to mount.

Foreground ownership is explicit within a binding. An incoming A/B surface can
prepare its initial presentation while hidden, but it must not acquire native
composer ownership, focus, typing activity, or read advancement before promotion.
Outgoing content may remain visible during the transition. Foreground-only work
stops at demotion; full unbind follows the transition and returns to Ready.

Typical transitions:

```text
mount -> Unbound (prepare reusable infrastructure)
Unbound --bind(parameters)--> Bound (foreground=false)
Bound --presentation ready + host promotion--> Bound (foreground=true)
Bound --unbind()--> Unbound
any live state --dispose()--> Destroyed
```

Host navigation is the sole authority to bind, promote, demote, and unbind.
Reactive conversation metadata may update a live binding's presentation, but may
never bind an unbound surface. A delayed teardown must identify the binding it
was scheduled for; it cannot clear a successor binding or a re-promoted surface.

## Infrastructure versus binding resources

### Reusable infrastructure

Prepare stable viewport/content nodes, the reusable scroller object, static
render hooks/configuration, and composer view infrastructure without requiring a
thread ID or source. Observers/listeners that remain installed in Ready must be
inert with respect to conversation work; per-binding observers should disconnect.

The kernel must support unbind/reset distinct from terminal disposal. Ready has
no mounted message items, message geometry, quote indexes, load indicators, or
conversation-specific tail state. If a structural helper node is retained, it
must be empty/inert and must not contribute stale conversation height.

Do not claim an initialization performance improvement without measuring it.
The purpose is a correct lifecycle first; reuse avoids unnecessary reconstruction
where infrastructure is actually reusable.

### Per-binding source

Create a fresh HttpItemSource when a binding needs history. Do not create a dummy
source merely to achieve infrastructure readiness, or reset a destroyed source
back into a live one. Its conversation, cursors, pending views, subscriptions,
and quote indexes belong to that binding alone.

Source construction cost has not been demonstrated to be a bottleneck. Prefer a
small, explicitly cancellable per-binding source over complicated source reuse.

### Composer shares the binding

The chatbox and composer subscribe to the same binding scope rather
than independently inferring their ownership from thread input changes.

- Bind restores the appropriate draft and prepares conversation-specific send,
  mention, quote, and attachment context.
- Foreground activation grants interaction/focus/typing and, where applicable,
  native composer ownership. A background preload cannot take that ownership.
- Demotion revokes foreground privileges and preserves outgoing presentation
  only as needed for the transition.
- Unbind saves the draft while its old identity is still valid, cancels
  binding-owned preparation, releases native ownership, clears transient input
  state and handlers, and returns the composer to an unbound prepared state.
- Delayed events from an old composer context cannot save into, send through, or
  mutate the next binding, including rebinds of the same thread.

Web may retain one composer view per A/B slot. Android retains its shared native
view/controller and transfers an exclusive context lease; shared lifecycle does
not mean creating one native editor per slot. Native business orchestration and
session validation remain Rust-owned; platform adapters retain only
OS resource safety responsibilities.

## Cancellation and unbind contract

Each bind creates a fresh scope. There is no generation counter and no identity
comparison: a scope is valid exactly while it has not been aborted, and unbind
aborts the previous scope before a successor can bind, so re-binding the same
thread cannot revive old results.

On unbind:

1. Mark the binding non-runnable and revoke publication rights before releasing
   resources. Save the draft against the captured old identity before clearing
   its composer context.
2. Abort binding-owned requests and stop subscriptions, demand pumps, timers,
   animation-frame work, and queued rendering/read/typing work.
3. Unmount every message item and release its item-local resources; clear source
   references, quote/pending view indexes, scroll anchors, load state, and
   conversation-specific composer state.
4. Return to Ready. No old completion may repopulate it or affect a new binding.

Propagate cancellation through the actual call chain. Unsubscribing a wrapper or
checking a flag only after a Promise resolves does not cancel underlying work.
For APIs that cannot abort, discard the late result when the captured scope's
signal is aborted; log once when the platform itself cannot cancel (for example
a pending browser permission prompt). Cleanup is idempotent and must not depend
on an uncooperative request completing.

Ownership limits are important:

- Cancel requests exclusively owned by the surface binding.
- Detach this consumer from shared repository work; abort shared transport only
  when its ownership/refcount contract permits it.
- Do not stop account-level synchronization, durable cache updates, shared media
  transfers, or an already-submitted outbox send simply because a surface unbinds.
- Persisted session/account epochs remain an outer boundary; a view binding
  scope does not replace them.

## Migration and deletion plan

1. Inventory kernel/source/composer async work and its owner, including repository
   requests, quote resolution, media consumers, native callbacks, and read tracking.
2. Introduce source-independent kernel preparation and explicit bind/unbind/dispose
   operations. Keep message loading and initial presentation out of preparation.
3. Implement the chat-surface owner and migrate both composer hosts to its binding
   identity and foreground rules.
4. Make ChatPane drive explicit lifecycle transitions for initial selection,
   A/B replacement, reselection, fast flip-back, close, and destruction.
5. Migrate all kernel/source users and tests, including the isolated chatbox demo
   and mocks. Remove implicit initialization from metadata effects.
6. Remove the interim `idledThreadId` guard and redundant lifecycle bookkeeping
   such as `currentTrdId`/`kernelReady`/blocked-ready combinations where the new
   state replaces them. Consolidate `reset`, `reinit`, and `teardownKernel` callers
   rather than leaving parallel old and new control paths. Retain genuinely
   distinct presentation flags only where required.
7. Audit and remove obsolete subscriptions, helpers, comments, and tests that
   encode the old teardown/reconstruction behavior. Do not remove regression
   assertions merely because their implementation-level selector changed.

Do not expand this into unrelated authentication, backend, or platform rewrites.
Existing unrelated worktree changes must be preserved.

## Required regression coverage

- Prepare without conversation parameters: no source, requests, items, or composer
  ownership; infrastructure preparation happens once per mounted surface.
- Bind, unbind, and rebind the same/different conversation: reusable infrastructure
  identity remains stable and per-binding source identity changes.
- Metadata, reconnect, media, and viewport events while Ready cannot restart work.
- Unbind during initial load, older/newer pulls, quote resolution, composer
  preparation, and queued rendering: cancellation is observed and late results
  cannot publish or mount nodes.
- Delayed teardown, same-thread rebind, rapid A/B flip-back, and component destroy
  cannot cancel or mutate a successor binding.
- Shared repository consumers and outbox/account tasks survive unrelated view
  unbind; binding-exclusive requests do not.
- Draft/quote/focus/typing/mention/native-context state cannot leak across bindings.
- Blocked/read-only/error presentations settle the host handshake correctly.
- Preserve integer-pixel geometry and transform-independent `offsetHeight`
  measurement. Test composer clearance on every frame during switching.
- Run shared-component unit tests, source/kernel cancellation tests, and the full
  Playground suite; native-context behavior additionally needs native validation.

## Implementation handoff

The kernel foundation now supports preparation without a source, explicit
`bind(source)`, reusable `unbind()`, and terminal `destroy()`. Unbind removes rows,
observers, listeners, binding geometry, and source ownership. Async initialization
and fill continuations abort with the binding signal; unbind aborts the binding signal,
unsubscribes fill demands, and settles the kernel's initial-load wait even if the
source cannot abort. `CbSourceInitOpts.signal` is now available for propagation.

HttpItemSource now consumes the binding signal and cancels its own source lifetime
on destroy. Browser history bootstrap/page HTTP subscriptions and anchor resolution
receive cancellation, subsequent walker steps check the combined cache/consumer
lifetime, and media-stage HTTP is unsubscribed. Quote lookups detach from local
non-abortable reads; profile observation is detached; late continuations cannot
repopulate source indexes or restore/reconcile pending views after destruction.
Already-admitted durable cache commits and outbox sends retain their own ownership.
Source-side cancellation uses an explicit lifetime scope. Kernel delivery is
owned by initialization, backfill, and edge subscriptions rather than generations
or post-await lifetime checks. Synchronous page delivery uses a same-turn queue
to avoid recursive subscription stack growth; each page is measured and the
remaining demand is checked before another page is requested.

This is not yet complete cancellation: individual edge-demand unsubscribe still
detaches its result rather than cancelling the source's whole history lane. Source
destruction cancels that lane. Native history now uses `native_message_history_start`
plus `native_message_history_cancel`, replacing the old single-result get command.
Rust registers a per-consumer cancellation token before spawning its task, pushes
one terminal result, and removes the registration on completion/cancellation.
Dropping the history future cancels its owned HTTP; already-admitted blocking cache
work can finish under the existing login/database owner and must not be mistaken
for an abortable HTTP request. The renderer forwards cancellation immediately, or
when a late registration handle arrives; terminal events after unbind are ignored.
Both desktop/mobile registrations and ACL entries were migrated together.

Normal pagehide sends per-request cancellation. Activity destruction does not
sweep the global history task registry: an old host must not cancel a new host's
requests. No startup drain barrier is required. If per-request cancellation is
not delivered, the task remains owned by Rust until completion or its normal
failure/timeout path; termination of the process releases its in-memory tasks.
Login/cache ownership remains independent.
Frontend and native binaries must be updated together for the changed IPC contract.

The initial host/surface migration is implemented: ChatPane dispatches explicit
binding commands after render; MessageThread prepares its kernel once and reuses
it across bindings. Metadata effects cannot bind an unbound surface. The old
`idledThreadId`, `blockedReadyTrdId`, `reset`, `reinit`, and `teardownKernel` paths
were removed; current thread/readiness are derived from the lifecycle state.
Delayed unbind checks the captured scope's abort state and pending incoming ownership.

Each binding scope owns a resource collection. The deletion subscription is no
longer a component field; scope revocation precedes cancellation and resource
release, and late registrations clean up immediately. The Web composer subscribes
to the shared lifecycle stream, saves drafts against the scope it captured rather
than a possibly changed input, and clears editor/recording/link-generation state on
unbind. Native composer visibility is gated by the scope and unbind releases
its context. Picker results discard themselves when their captured scope aborted;
link-generation requests are unsubscribed (transport-cancelled) on rebind.

This is still a partial migration: composer conditional template branches can
recreate its view; native ownership/lifecycle and pending platform callbacks need
further audit and device validation. The kernel's transitional source-in-constructor
path has been removed: the scroller is constructed without a source and every caller
(including the forwarded-history view) binds explicitly, reusing one kernel across
nested bundles via unbind/bind.

Validation of this foundation: 192 kernel/source tests passed; two component suites
initially failed to import through Vite, then passed separately (28 tests). The full
Playground suite passed all 16 tests. New kernel regressions cover unbound preparation,
reuse, late init/re-anchor completion, abort signaling, and initial-fill unsubscribe.
The subsequent item-height subscription and fully-visible identity cleanup was
also verified by re-running all 134 kernel tests successfully.

After the transitional constructor entry was deleted (spec suites compose a
construct-then-bind helper), all 134 kernel tests passed again, forward-detail
projection tests and the thread component suite passed, and the full Playground
run passed 16/16.

Earlier worktree changes include corrected Playground prerequisites. The interim
idle-thread guard has now been replaced by explicit binding ownership; passing
Playground does not mean every cancellation and host boundary is complete.

Latest cancellation validation: 214 kernel/source/repository/helper tests passed.
The first full Playground run passed eight tests, then timed out waiting for the
home-shell fixture and a replacement server; the command later hit its overall
600-second limit. An unchanged rerun passed all 16 tests in 3.2 minutes. The startup
timeout root cause remains unverified; no assertions or fixture timeouts were
relaxed. Source regressions cover browser cancellation propagation, media HTTP
unsubscribe, late quote results, and preventing source subscription revival.

Native cancellation validation: all 274 Rust library tests passed, including a real
TCP regression that holds a history HTTP response open, cancels the consumer,
observes socket EOF, and verifies the login owner remains current. Registration
races and sibling isolation have Rust tests; the late-handle/early-result/pagehide
transport races have browser tests. The related frontend suites passed 81 tests,
and IPC ACL contracts passed. This is not an Android device validation.

Latest surface/resource validation: 33 lifecycle/component/composer tests passed,
including cleanup order/failure/late registration, same-thread rebind isolation,
old-identity draft persistence, and late picker suppression. All 16 Playground
cases passed in 3.3 minutes, including blocked reselection and per-frame composer
clearance at both widths. Existing host tests now assert an explicit initial bind
as well as resident rebind, instead of assuming input changes initialize the child.

The Web composer now keeps its instance across blocked/read-only/paused states,
revokes its business context and contributes no geometry while disabled. The
shared lifecycle stream replaces parent-driven kernel/composer cleanup. A real
constructor/effect test verifies composer Unbound cleanup completes synchronously
without awaiting change detection, and rebind restores a fresh scope.

Latest validation: lifecycle/message tests passed; two suites initially failed Vite
dynamic import, then the host/composer suites passed separately. The additional
synchronous composer test passed. Full Playground passed all 16 cases after
updating the read-only assertion from absent DOM to retained-but-hidden, inert,
unbound DOM. The blocked flow also verifies identical composer DOM across repeated
block/unblock and draft restoration. No source/picker/upload policy was changed
in this subscription migration.

Remaining release work includes Android device validation and review of any
separate upload/binding redesign. Global history cancellation was intentionally
removed; per-request cancellation and channel pairing remain. No host-drain barrier
or host-scoped history registry is required by this decision. Do not claim Android
runtime validation from browser tests.
