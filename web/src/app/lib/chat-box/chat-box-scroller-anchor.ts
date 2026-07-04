/**
 * ChatBoxScrollerAnchor — Plan A: pins the viewport via the browser's overflow-anchor (a hard fork from Plan B, for
 * A/B comparison).
 *
 * [array index-based] The kernel keeps an ordered `mounted: Entry[]` array (mounted[0] = oldest / DOM top → last =
 *  newest / bottom); the index is a window-local index (non-cumulative, direction-agnostic, naturally bidirectional).
 *  item.id (msgId) is only a source cursor and **takes no part in position arithmetic**. The prefix-sum `prefix[]`
 *  (flushPrefix lazy-invalidated) makes topOf/totalH O(1) amortized.
 *
 * Isomorphic to Plan B ({@link ChatBoxScroller}): array index + source-driven, pixel-threshold window, checkpoint
 *  loading, trim, mergeItems hook (album merging in the kernel, per-batch). The ONLY difference: it **does not write
 *  scrollTop compensation** — prepending older / above-viewport height changes / trimming the top never move scrollTop;
 *  the browser's `overflow-anchor: auto` (default) pins the first visible element.
 *
 * So Plan A has no "the snapshot used for post-async-resolve compensation goes stale" risk surface (the async strategy
 *  only re-validates — no compensation arithmetic) — this is the root reason Plan A is smoother in fling + slow-load
 *  scenarios. Cost: no iOS build supports overflow-anchor → Plan A is Android-only.
 *
 * Note: revalidation is still required (avoid mounting on a reverse fling / at a boundary); only compensation is removed.
 * Prerequisite: the host viewport has overflow-anchor: auto (default); Plan B's playground sets none so the manual
 * compensation owns it exclusively.
 */
declare const ngDevMode: boolean | null | undefined;

import type { CbSource } from './cb-source';
import type {
  CbItem, CbElement, CbHooks, CbOptions, CbScrollInfo, CbDebugStats, CbConfig, ScrollerApi, CbInitOpts, Anchor,
} from './chat-box-scroller';

export type { CbItem, CbElement, CbHooks, CbOptions, CbScrollInfo, CbDebugStats, CbConfig, ScrollerApi, CbInitOpts, Anchor } from './chat-box-scroller';

const DEFAULTS: Required<CbConfig> = {
  edge: 1000, mountItem: 50, thresholdFloor: 6000, vhExtra: 2000, initBatch: 100,
};

/** Safety timeout backing the enter/leave/move CSS animations (cb-enter/cb-leave/cb-move in _cb.scss). Must exceed the
 *  longest CSS duration (~0.22s for cb-move); 0.45s leaves a ~230ms margin for a swallowed animationend to self-clear
 *  without the lag the old 0.6s backstop added now that the animations themselves are snappier. */
const ANIM_SAFETY_MS = 450;

/** Mounted entry: item (with msgId) + element handle + cached height + height unsubscribe. Fields are mutable (rebuild replaces el/vs/height/unsub). */
interface Entry<T> {
  item: CbItem<T>;
  el: HTMLElement;
  vs: CbElement<T>;
  height: number;
  unsub: () => void;
  /** True for items inserted via insertAfter (not registered with the source). Their id is not a source cursor, so
   *  cursor derivation (olderCursorId/newerCursorId) skips them — prevents a transient at the head/tail from making
   *  getOlder/getNewer return [] and falsely locking noOlder/noNewer. */
  transient: boolean;
  /** True for an in-flight pending send (insertAfter {optimistic:true}): registered with source.pending, returned by
   *  getNewer when the real batch is short. Skipped by cursor derivation and protected from trim (atomic block). */
  optimistic: boolean;
  /** True for a just-mounted real item confirming an optimistic send — mounted visibly and flagged so reconcileOptimistic
   *  removes the matching optimistic duplicate and tags this real cb-confirmed. No hiding: the swap is synchronous within
   *  the loadNewer→reconcile microtask (never painted as two bubbles). Set by the loadNewer mount-dispatch; cleared at reconcile. */
  resortTarget: boolean;
  /** True on a mount that should play the cb-enter animation (insertAfter + appendLive only; scroll-loaded history
   *  batches never animate). Consumed once by measurePending (after cb-pending is dropped): calls enterAnim and clears it. */
  animate: boolean;
  /** Set true on a mount whose enter must come FROM ABOVE (cb-enter-above) instead of from below (cb-enter). Used by
   *  mountNewerReals when an optimistic/transient tail block is present: a newer batch inserts reals just above the
   *  tail, and a downward enter would visually cross (cover) the pending mid-animation, so the real descends into its
   *  slot from the newest-real side while the tail shoves down via cb-move. Consumed once by measurePending alongside
   *  `animate` to pick the enter class; cleared after. */
  enterAbove: boolean;
  /** True while the cb-leave exit animation is in flight. The entry STAYS in mounted[] (height still counted) until
   *  animationend so the height model stays exact; cursor derivation skips it like transient. Set by removeItem. */
  leaving: boolean;
  /** Guards double-fire of the leave completion (animationend + safety timeout both call the same handler). */
  leaveDone: boolean;
  /** Safety timer in case animationend is swallowed during a leave (cleared on completion / teardown). */
  leaveTimer?: ReturnType<typeof setTimeout>;
  /** enter-animation safety timer (cb-enter). Undefined when not animating or already finished; its presence is the
   *  "still in flight" signal used by teardown to decrement `animating` exactly once. */
  enterTimer?: ReturnType<typeof setTimeout>;
  /** FLIP-move (cb-move) safety timer. Undefined when not moving or already finished; its presence is the "still in
   *  flight" signal used by teardown (cancelEntryAnim) to decrement `animating` exactly once. Set by flipMove when a
   *  reconcilePending reorder (or status-morph height delta) shifts the entry's absolute top. */
  moveTimer?: ReturnType<typeof setTimeout>;
  /** rAF id scheduling the cb-enter kickoff (see enterAnim). The animation class is added on the NEXT frame so the
   *  browser commits the pre-state first; cb-pending is held until the rAF fires, then atomically dropped with the
   *  class so the first painted frame is the @keyframes `from` (no one-frame flash at opacity:1). Present between
   *  enterAnim and the rAF callback; cancelEntryAnim cancels it (and balances `animating`) on teardown/re-seed. */
  enterRaf?: number;
  /** rAF id scheduling the cb-leave kickoff (see leaveEntry). Mutually exclusive with leaveTimer/leaveDone. */
  leaveRaf?: number;
  /** rAF id scheduling the cb-move kickoff (see flipMove). The invert var is set synchronously; the class is added on
   *  the next frame (rAF runs before paint, so the @keyframes `from` applies for the first painted frame — no flash at
   *  the new layout position, and no forced reflow). Mutually exclusive with moveTimer. */
  moveRaf?: number;
}

export class ChatBoxScrollerAnchor<T = unknown> implements ScrollerApi<T> {
  private readonly viewport: HTMLElement;
  private readonly content: HTMLElement;
  private readonly hooks: CbHooks<T>;
  private readonly source: CbSource<T>;
  private readonly cfg: Required<CbConfig>;
  private readonly initOpts: { chatId?: number };
  private readonly onScroll?: (info: CbScrollInfo) => void;
  private readonly onDebug?: (stats: CbDebugStats) => void;
  private readonly isFrozen: () => boolean;

  /** Ordered mounted entries: index 0 = oldest (DOM top) → last = newest (DOM bottom). Window-local index. */
  private mounted: Entry<T>[] = [];
  /** Prefix sum: prefix[i] = Σheight[0..i-1] (prefix[0]=0, prefix[n]=totalH). flushPrefix recomputes when dirtyPrefix. */
  private prefix: number[] = [0];
  private dirtyPrefix = true;

  private noOlder = false;
  private noNewer = false;
  /** The entry currently showing the skeleton (= mounted[0] when !noOlder); null = no skeleton. Compared by entry
   *  reference (immune to array shifts). */
  private ghostEntry: Entry<T> | null = null;

  /** Tail cap: a persistent non-message element kept as the last child of content (NEVER in mounted[]), mirroring the top
   *  ghost at the newer edge. Gap mode (noNewer, at the global newest) = a small spacer; loading mode (!noNewer) = the same
   *  spinner as the top ghost. Its height is folded into totalH() but never into prefix[]/topOf, so it neither shifts any
   *  real item's position nor corrupts the newer cursor (mounted[last].item.id). Created once in the ctor; reused, never
   *  duplicated, across batches — every append inserts before it, so it is continuously the last child (no accumulation). */
  private tailCapEl: HTMLElement | null = null;
  private tailCapH = 0;
  private readonly tailCapObs: ResizeObserver = new ResizeObserver(() => {
    if (this.tailCapEl) this.tailCapH = this.tailCapEl.offsetHeight; // re-measure on async/responsive height change
  });
  private inflightOlder = false;
  private inflightNewer = false;
  /** Reset generation: incremented by openAround; compared after the await in loadOlder/loadNewer so stale batches are
   *  not mounted (guards against a jump overtaking an in-flight load). */
  private gen = 0;
  /** Re-seed in progress (between resetWindowState and mount): appendLive drops WS during this (already in the source
   *  cache, retrieved by getNewer when scrolling back). */
  private resetting = false;
  /** Debug switch: turn off the mount checkpoint (balance will not trigger loadOlder/loadNewer). Guarded by ngDevMode
   *  inside balance → removed in prod AOT. Default false (checkpoint loads normally). */
  closeCheckpoint = false;

  /** Queue of entries awaiting real-height measurement (entry refs; the callback reads the current index via indexOf). */
  private pendingMeasure: Entry<T>[] = [];

  private vh = 0;
  private shifting = false;   // suppresses scroll-direction misdetection caused by programmatic scrollTop writes (scrollToBottom, etc.)
  /** Set after a viewport-resize reflow re-pins to bottom; onNativeScroll consumes it once so the async scroll event
   *  the pinToBottom write fires does not re-arm balance/load/trim during a viewport shrink (soft keyboard, etc.). */
  private suppressScrollBalance = false;
  /** Set when onViewportResize was called while {@link isFrozen} (immunity frame) and thus skipped.
   *  flushViewportResize applies it once on thaw so a real viewport change during the freeze is not lost. */
  private resizeDeferred = false;
  private mounting = false;
  private measuring = false;
  private destroyed = false;
  private dirty = false;
  private rafId = 0;
  private lastScrollTop = 0;
  private mountTick = 0;
  private unmountTick = 0;
  /** Count of in-flight enter/exit (cb-enter/cb-leave) animations. While > 0, scheduleBalance defers (sets deferBalance)
   *  instead of scheduling a RAF — no load/trim runs during an animation. Mount/unmount/settle ops are NOT blocked:
   *  each manages this counter, so add+remove and multi-remove animate concurrently. Drains to 0 on animationend. */
  private animating = 0;
  /** Set when a balance was requested while animating>0; fired once when animating drains to 0. */
  private deferBalance = false;
  /** Single-flight guard for {@link onMessageSignal}: a signal arriving while one is in-flight is collapsed into ONE
   *  tail pass that runs after the in-flight pass resolves (and loops to drain further arrivals). Without this, two SSE
   *  frames landing in the same microtask window race on shared viewport/tail state: the second call's loadNewer bails
   *  on `inflightNewer` (orphaning its items in the live cache until the NEXT signal), and both calls' flipMove overlap
   *  on the surviving optimistic tail (moveTimer overwritten → animating leaks; the shove double-plays). Tail-coalescing
   *  makes the pair run strictly in order — the only correct interleaving for an async handler that mutates mount order,
   *  the height model, and the viewport. Plan A relies on overflow-anchor for the pin, but the mount/height mutation
   *  ordering is identical to Plan B, so the same guard applies. */
  private signalInFlight = false;
  private signalQueued = false;
  /** Set during reconcileOptimistic. Reconcile is synchronous (no slide) and never spans an await, so this is never
   *  observed true by a deferred trim — kept so trimOlder/trimNewer (rule 4a) stay self-documenting. */
  private resorting = false;
  private readonly viewportObs: ResizeObserver;
  /** visualViewport→onViewportResize throttle id (coalesces a keyboard-open burst of resize/scroll events into one
   *  re-pin per frame). 0 = no pending re-pin. */
  private vvRafId = 0;
  /** Definitive keyboard re-pin signal: the viewport element's ResizeObserver alone is unreliable on mobile (the
   *  layout viewport does not resize on iOS, and a lift-driven resize can race browser scroll-restore), so this also
   *  fires onViewportResize from visualViewport resize/scroll. Reads viewport.clientHeight (NOT visualViewport.height)
   *  for the actual height, so the Samsung address-bar inflation of visualViewport.height never reaches the model. */
  private readonly onVisualViewportChange = (): void => {
    if (this.vvRafId || this.destroyed) return;
    this.vvRafId = requestAnimationFrame(() => { this.vvRafId = 0; this.onViewportResize(); });
  };

  constructor(opts: CbOptions<T>) {
    this.viewport = opts.viewport;
    this.content = opts.content;
    this.hooks = opts.hooks;
    this.source = opts.source;
    this.onScroll = opts.onScroll;
    this.onDebug = opts.onDebug;
    this.isFrozen = opts.isFrozen ?? (() => false);
    this.initOpts = opts.initOpts ?? {};
    this.cfg = { ...DEFAULTS, ...opts.config };
    this.viewportObs = new ResizeObserver(() => this.onViewportResize());
    this.measureVh();
    this.viewportObs.observe(this.viewport);
    this.viewport.addEventListener('scroll', this.onNativeScroll, { passive: true });
    // visualViewport: the definitive keyboard-show/hide signal (see onVisualViewportChange). The viewport element's
    // own ResizeObserver fires only when its border-box changes, which on mobile keyboards it often does not (or does
    // so unreliably); this listener guarantees the re-pin runs on every visual-viewport change regardless.
    window.visualViewport?.addEventListener('resize', this.onVisualViewportChange);
    window.visualViewport?.addEventListener('scroll', this.onVisualViewportChange);
    // Tail cap: created once, appended as the only/last child. Every later createEntry inserts before it (see createEntry),
    // so it stays the permanent last child of content across all mounts/re-seeds; removed only in destroy.
    this.tailCapEl = document.createElement('div');
    this.tailCapEl.className = 'cb-tail-cap';
    this.content.appendChild(this.tailCapEl);
    this.tailCapObs.observe(this.tailCapEl);
  }

  private get threshold(): number {
    return Math.max(this.vh + this.cfg.vhExtra, this.cfg.thresholdFloor);
  }

  async init(opts?: CbInitOpts): Promise<void> {
    // Jump / re-anchor: open at a specific message (bidirectional fetch + centered positioning), skip the newest-layout path.
    const startId = opts?.startMsgId ?? null;
    if (startId !== null) { await this.openAround(startId, opts?.anchor ?? 'center', opts?.highlight ?? false); return; }
    let batch = await this.source.init(-1, this.cfg.initBatch, 0, this.initOpts);
    let merged = this.mergeBatch(batch);
    if (merged.length === 0) {
      // Empty thread: the empty sequence is trivially at BOTH edges. Marking noOlder/noNewer here is what makes an
      // empty chat report "pinned to bottom" (noNewer) — without it, an optimistic send is mis-routed through the
      // trimmed-newer queue path, which can never drain on an empty thread, so the first message never mounts.
      this.noOlder = true;
      this.noNewer = true;
      this.scrollToBottom();
      this.updateGhost();
      this.emit();
      return;
    }
    this.absorbBoundary(merged);
    this.mountBatch(merged, 'init');
    while (this.totalH() < this.threshold && !this.noOlder && this.mounted.length > 0) {
      const cursor = this.mounted[0].item.id; // oldest mounted msgId
      batch = await this.source.getOlder(cursor, this.cfg.initBatch);
      merged = this.mergeBatch(batch);
      if (merged.length === 0) { this.noOlder = true; break; }
      this.absorbBoundary(merged);
      this.mountBatch(merged, 'older'); // no internal measure
      this.measurePending();            // unified measure for fill batches
    }
    this.scrollToBottom();
    this.updateGhost();
  }

  appendLive(rawItems: CbItem<T>[]): void {
    if (this.destroyed || rawItems.length === 0) return;
    // Direct-mount path for live items (production WS incoming). Cache via pushLive, then mount at the tail (dedup by
    // id). Plan A relies on overflow-anchor to pin the viewport (no manual compensation). NOT the optimistic-confirm
    // path — that goes through onMessageSignal (reconcile).
    this.source.pushLive(rawItems);
    if (this.resetting) { this.emit(); return; }
    const remaining = rawItems.filter(it => this.indexOfId(it.id) < 0);
    if (remaining.length === 0) { this.emit(); return; }
    if (!this.noNewer) { this.emit(); return; }              // newer end trimmed → cache only
    const wasAtBottom = this.isAtBottom();
    const merged = this.mergeBatch(remaining);
    this.mountBatch(merged, 'newer', true);
    this.noNewer = true;
    if (wasAtBottom) this.scrollToBottom();                  // overflow-anchor pins; pin to reveal the new message
    this.emit();
  }

  /** Signal that new messages are available (the source already cached them via pushLive). If the kernel still mounts
   *  the global newest, pull via loadNewer, run reconcileOptimistic, follow to the bottom if pinned — pinning AFTER
   *  reconcile so the target is the final bottom (the optimistic duplicate is already removed, not counted) — and trim.
   *  Plan A relies on overflow-anchor (no manual scrollTop compensation). */
  async onMessageSignal(): Promise<void> {
    if (this.destroyed || this.resetting) return;
    // Single-flight + tail-coalesce (mirrors Kernel B): two SSE frames can land in the same microtask window. Running
    // them concurrently races — the second's loadNewer bails on inflightNewer (orphaning its items in the live cache)
    // and both flipMove the optimistic tail (leaking `animating`, double-playing the shove). Collapse any overlap into
    // ONE tail pass after the in-flight pass resolves, looping until no further signal arrived during a pass.
    if (this.signalInFlight) { this.signalQueued = true; return; }
    this.signalInFlight = true;
    try {
      do {
        this.signalQueued = false;
        await this.runMessageSignal();
      } while (this.signalQueued && !this.destroyed && !this.resetting);
    } finally {
      this.signalInFlight = false;
    }
  }

  private async runMessageSignal(): Promise<void> {
    if (!this.noNewer) return;                               // newer end trimmed → cached only; load on scroll-back
    const wasAtBottom = this.isAtBottom();

    // Coordinated enter/shove animation — FLIP "First": snapshot the optimistic tail's absolute tops at their LAST
    // PAINTED position (before loadNewer inserts the new reals above them and reconcile removes any confirmed duplicate).
    // After those mutations, flipMove replays the surviving tail from these tops to its new position (the shove) in the
    // same synchronous task as the new reals' cb-enter-above (started in measurePending), so the pair shares one frame.
    const tailBefore = this.mounted.filter(e => e.optimistic && !e.leaving);
    const tailOldTop = new Map<Entry<T>, number>();
    if (tailBefore.length > 0) {
      this.flushPrefix();
      for (const e of tailBefore) tailOldTop.set(e, this.topOf(this.mounted.indexOf(e)));
    }

    const n = await this.loadNewer(true);                   // forced: the signal means new data is available; returns the count of newly mounted items (0 = nothing new this pass — mirrors the `n` used in followToNewest)
    if (this.destroyed) return;
    if (n === 0) return;                                    // nothing new mounted → no shove to play, no new bottom to follow. Common for the tail-coalesced follow-up pass: by the time it runs, the in-flight pass already drained the live cache, so this one has nothing to do. Safe to skip reconcileOptimistic/flip/trim/pin: mountNewerReals — the only setter of resortTarget — did not run.
    await this.reconcileOptimistic();                        // remove optimistic duplicates (synchronous) so the bottom is final
    if (this.destroyed) return;

    // FLIP "Play": animate the surviving optimistic tail from its pre-batch tops (the shove). No-op when nothing remains
    // (single-send confirm: the lone pending was the removed duplicate) or when heights match (delta 0 → skipped), the
    // common case since a real confirms an optimistic of the same content.
    if (tailOldTop.size > 0) {
      this.flipMove(this.mounted.filter(e => e.optimistic && !e.leaving), tailOldTop);
    }

    // Trim + ghost + cap BEFORE the pin: these mutate content (remove top items → scrollHeight shrinks), so pinning to the
    // FINAL bottom must come after them (mirrors Kernel B). Pinning before trim anchored scrollTop to a pre-trim bottom and
    // the subsequent trim shifted it off → the latest message dropped below the fold on the first send.
    this.trimOlder();
    this.updateGhost();
    this.updateTailCap();
    if (wasAtBottom) this.pinToBottom();                     // follow to the FINAL bottom (after reconcile + trim)
    this.emit();
  }

  /**
   * Insert one item immediately after the mounted entry representing afterId. No-op (returns false) if afterId is not
   * mounted or a re-seed is in progress.
   *
   * **No balance**: does not call loadOlder/loadNewer/trim. measurePending settles the height under the `measuring`
   *  guard and does not schedule a balance. Plan A **does not compensate scrollTop** (the browser's overflow-anchor
   *  pins the viewport) — this is the one divergence from Plan B, which compensates manually; Plan A delegates to the
   *  browser.
   *
   * The successor (the entry that was at idx+1) has its prev changed (target → new item) → rebuilt in place to
   * recompute group-head/date (same lightweight rebuild as the ghost reveal); entries further down keep the same prev
   * and need no rebuild. The new entry is marked transient (not a source cursor).
   */
  insertAfter(afterId: string | number, item: CbItem<T>, opts?: { optimistic?: boolean }): boolean {
    if (this.destroyed || this.resetting) return false;
    // Empty window: there is no anchor to insert "after", so the item becomes the sole entry (prev=null). This is the
    // first-message-in-an-empty-thread path — afterId is irrelevant there (and typically '' / the optimistic's own id,
    // since tailAnchorId() is empty when nothing is mounted). animate=true: a new message is appearing. Plan A needs no
    // manual scrollTop compensation (the browser's overflow-anchor pins the viewport).
    if (this.mounted.length === 0) {
      const entry = this.createEntry(item, null, null, true);
      if (opts?.optimistic) entry.optimistic = true;
      else entry.transient = true;
      this.mounted.push(entry);
      this.dirtyPrefix = true;
      this.measurePending();
      this.updateTailCap(); // mounted 0→1 (e.g. first pending in an empty thread): flip the cap hidden→gap so the bottom padding shows
      this.emit();
      return true;
    }
    const idx = this.indexOfId(afterId);
    if (idx < 0) return false;                  // not mounted → neglect the insert request
    const target = this.mounted[idx];
    const successor = this.mounted[idx + 1] ?? null;
    const anchorEl = successor ? successor.el : null;

    // New entry: prev = target item (older neighbor). DOM lands between target and successor (createEntry inserts
    // before anchorEl; no successor -> append). animate=true so it plays cb-enter once measured.
    const entry = this.createEntry(item, target.item, anchorEl, true);
    if (opts?.optimistic) entry.optimistic = true;   // pending send (in source.pending, returned by getNewer, atomic)
    else entry.transient = true;                      // FAKE debug insert (viewport-only)
    this.mounted.splice(idx + 1, 0, entry);
    if (successor) this.rebuildEntry(successor); // prev changed → recompute group-head/date (height reset, re-measured below)

    this.dirtyPrefix = true;
    this.measurePending();                       // `measuring` suppresses onElHeight compensation/balance
    // Plan A: the browser's overflow-anchor automatically pins the viewport (an above-viewport insert/height change
    // does not jump), so no manual scrollTop compensation is needed.
    this.updateTailCap();                         // keep the newer-edge cap in sync after a mounted mutation
    this.emit();
    return true;
  }

  /**
   * Remove mounted entries by id (fake/pending/real, or any album-member id). Accepts one id or an array. Each removed
   * entry plays a cb-leave exit animation; the logical unmount is deferred to animationend (the entry STAYS in mounted[],
   * height still counted, until then — so the height model stays exact). No `animating>0` guard: removes run concurrently
   * with each other and with inserts; only balance is gated by animating. Returns the count scheduled for removal.
   */
  removeItem(ids: string | number | (string | number)[]): number {
    if (this.destroyed || this.resetting) return 0;
    const list = Array.isArray(ids) ? ids : [ids];
    const targets: Entry<T>[] = [];
    for (const id of list) {
      const idx = this.indexOfId(id);                 // album-aware (itemHasId -> whole album item)
      if (idx < 0) continue;
      const e = this.mounted[idx];
      if (!e.leaving && !targets.includes(e)) targets.push(e); // dedup (several album ids -> same entry)
    }
    for (const e of targets) this.leaveEntry(e);      // each starts its own concurrent cb-leave
    if (targets.length > 0) this.emit();
    return targets.length;
  }

  /** Start one entry's cb-leave exit: mark leaving, animating++, and kick the class off on the next rAF (consistent
   *  with enter/move — every animation begins on a frame boundary). cb-leave's `from` (opacity:1) matches the entry's
   *  current visible state, so the one-frame deferral is invisible. Completion (unmount) runs on animationend or the
   *  safety timeout; Plan A does not compensate scrollTop (browser overflow-anchor pins the viewport). leaveRaf
   *  (rAF pending) and leaveTimer/leaveDone (running) are handled by cancelEntryAnim. */
  private leaveEntry(entry: Entry<T>): void {
    entry.leaving = true;
    entry.leaveDone = false;
    this.animating++;
    entry.leaveRaf = requestAnimationFrame(() => {
      entry.leaveRaf = undefined;
      if (this.destroyed || entry.leaveDone) { this.onAnimEnd(); return; } // torn down / cancelled mid-frame
      entry.el.classList.add('cb-leave');
      const onEnd = (): void => {
        if (entry.leaveDone) return;
        entry.leaveDone = true;
        if (entry.leaveTimer !== undefined) { clearTimeout(entry.leaveTimer); entry.leaveTimer = undefined; }
        entry.el.classList.remove('cb-leave');
        const i = this.mounted.indexOf(entry);          // re-find (concurrent removes shift indices)
        if (i >= 0) this.unmountAt(i);
        entry.leaving = false;
        this.onAnimEnd();                               // drains animating; fires the deferred balance
      };
      entry.el.addEventListener('animationend', onEnd, { once: true });
      entry.leaveTimer = setTimeout(onEnd, ANIM_SAFETY_MS); // safety if animationend is swallowed
    });
  }

  scrollToBottom(): void {
    if (this.destroyed) return;
    this.pinToBottom();
    // The newest end may be trimmed away by trimNewer (window moved back, noNewer=false) → load back to the global
    // newest (the followToNewest chain, looping until noNewer).
    if (!this.noNewer) void this.followToNewest();
  }

  /** Position the viewport at the content bottom — the bottom {@link Anchor}, applied via {@link applyAnchor}. */
  private pinToBottom(): void {
    this.applyAnchor({ mode: 'bottom' });
  }

  /**
   * Snapshot the current viewport position as an {@link Anchor}. Plan A uses this only for resize (the at-bottom test
   * before re-measuring vh); stabilization is browser-delegated (overflow-anchor), so unlike Plan B the load/insert/
   * height-change sites do NOT capture+apply. Uses the kernel height model (totalH) for the at-bottom test, matching
   * Plan B's reasoning (DOM scrollHeight may already reflect a pending change).
   */
  private captureAnchor(): Anchor {
    if (!this.resetting && this.pendingMeasure.length === 0
      && this.viewport.scrollTop + this.vh >= this.totalH() - 1) return { mode: 'bottom' };
    const idx = this.topVisibleIdx();
    if (idx < 0) return { mode: 'bottom' };
    return {
      mode: 'item',
      id: this.mounted[idx].item.id,
      offset: this.viewport.scrollTop - this.topOf(idx),
      fallbackId: idx + 1 < this.mounted.length ? this.mounted[idx + 1].item.id : null,
    };
  }

  /**
   * The single positioning write for Plan A (mirrors Plan B). Derives scrollTop from the anchor and clamps. Does NOT
   * set suppressScrollBalance globally — only onViewportResize (the one site that can pin at a trimmed bottom with
   * noNewer=false) sets it manually, as before. Positioning writes here are honored directly by the browser; they do
   * not interfere with overflow-anchor (that engages on content changes, not explicit scrollTop sets).
   */
  private applyAnchor(a: Anchor): void {
    if (this.destroyed) return;
    let target: number;
    if (a.mode === 'bottom') {
      target = this.content.scrollHeight - this.vh;
    } else {
      let idx = this.indexOfId(a.id);
      if (idx < 0 && a.fallbackId != null) idx = this.indexOfId(a.fallbackId);
      target = idx >= 0 ? this.topOf(idx) + a.offset : this.viewport.scrollTop;
    }
    const max = this.content.scrollHeight - this.vh;
    this.shifting = true;
    this.viewport.scrollTop = Math.max(0, Math.min(target, max));
    this.shifting = false;
    this.lastScrollTop = this.viewport.scrollTop;
    this.emit();
  }

  /** Index of the topmost item whose top is at or above the viewport top (last i with prefix[i] <= scrollTop). */
  private topVisibleIdx(): number {
    this.flushPrefix();
    const st = this.viewport.scrollTop;
    let idx = -1;
    for (let i = 0; i < this.mounted.length; i++) {
      if (this.prefix[i] <= st) idx = i; else break;
    }
    return idx;
  }

  /** Explicit go-to-bottom follow (started by scrollToBottom): keep loading one newer batch and re-pinning until the
   *  global newest (noNewer). Plan A re-pins explicitly (overflow-anchor also helps). gen guard bails if a jump overtakes. */
  private async followToNewest(): Promise<void> {
    const g = this.gen;
    while (!this.noNewer && !this.destroyed && this.mounted.length > 0) {
      const n = await this.loadNewer();
      if (this.destroyed || g !== this.gen) return;
      if (n === 0) break;
      this.pinToBottom();
    }
  }

  scrollToTop(): void {
    if (this.destroyed) return;
    // The content origin (the oldest item's top is always prefix[0] = 0): the one intentional absolute write.
    this.shifting = true;
    this.viewport.scrollTop = 0;
    this.shifting = false;
    this.lastScrollTop = 0;
    this.emit();
  }

  scrollToIndex(id: string | number, anchor: 'top' | 'center' | 'bottom' = 'center', highlight = false): void {
    if (this.destroyed) return;
    const idx = this.indexOfId(id);
    if (ngDevMode) console.log('[JUMP] scrollToIndex id=', id, 'alreadyMounted idx=', idx);
    if (idx >= 0) { // already mounted: position directly
      this.positionMounted(idx, anchor);
      if (highlight) this.flashHighlight(idx);
      return;
    }
    // not mounted: re-seed the window around id, then position
    void this.openAround(id, anchor, highlight);
  }

  /**
   * Reset the window around id: unmount the current window → source.init(id, older, newer) fetches one bidirectional
   * batch → mount → fillAround fills both ways → position onto id. Plan A **does not compensate scrollTop** (the
   * browser's overflow-anchor pins the viewport); gen is incremented so in-flight loadOlder/loadNewer are invalidated;
   * resetting drops appendLive (WS messages are cached in the source, retrieved by getNewer on scroll-back). A centered
   * anchor needs enough content on both sides for a "true center"; fillAround grows the window to threshold (best-effort
   * near boundaries, where clamp concedes).
   */
  private async openAround(id: string | number, anchor: 'top' | 'center' | 'bottom', highlight: boolean): Promise<void> {
    const g = ++this.gen;
    if (ngDevMode) console.log('[JUMP] openAround start id=', id, 'gen=', g, 'vh=', this.vh, 'threshold=', this.threshold);
    this.resetWindowState();
    try {
      const batch = await this.source.init(id, this.cfg.mountItem, this.cfg.mountItem, this.initOpts);
      if (this.destroyed || g !== this.gen) { if (ngDevMode) console.log('[JUMP] bail: gen overtaken / destroyed'); return; } // overtaken by newer jump / destroyed
      const merged = this.mergeBatch(batch);
      const hasTarget = merged.some(it => this.itemHasId(it, id));
      if (ngDevMode) console.log('[JUMP] init batch merged=', merged.length, 'hasTarget=', hasTarget, 'ids=', merged.slice(0, 2).map(i => i.id), '..', merged.slice(-2).map(i => i.id), 'noOlder/noNewer=', this.noOlder, this.noNewer);
      if (merged.length === 0 || !hasTarget) { this.updateGhost(); this.emit(); return; } // source did not return target
      this.absorbBoundary(merged);
      this.mountBatch(merged, 'init');
      this.measurePending();
      if (ngDevMode) console.log('[JUMP] after init mount+measure: mounted=', this.mounted.length, 'totalH=', Math.round(this.totalH()), 'sampleH=', this.mounted.slice(0, 5).map(e => Math.round(e.height)));
      await this.fillAround(id, g); // fill both ways to threshold/2 (boundary exceptions) + compensate the open side when one side hits a boundary
      if (this.destroyed || g !== this.gen) { if (ngDevMode) console.log('[JUMP] bail after fill: gen overtaken'); return; }
      if (ngDevMode) console.log('[JUMP] fill done: mounted=', this.mounted.length, 'range=', this.mounted[0]?.item.id, '..', this.mounted[this.mounted.length - 1]?.item.id, 'totalH=', Math.round(this.totalH()), 'noOlder/noNewer=', this.noOlder, this.noNewer);
      const idx = this.indexOfId(id);
      if (idx >= 0) {
        this.positionMounted(idx, anchor);
        if (highlight) this.flashHighlight(idx);
      } else if (ngDevMode) console.log('[JUMP] target not found after fill (idx=-1)!');
      this.updateGhost();
      this.emit();
    } finally {
      this.resetting = false;
    }
  }

  /**
   * Window fill for a centered jump:
   *  1) Fill upward while aboveTarget < threshold/2 (or hit noOlder); fill downward while belowTarget < threshold/2
   *     (or hit noNewer).
   *  2) Compensate: if one side hit a boundary (< threshold/2) → fill the OTHER (still-open) side until totalH ≥
   *     threshold (if both hit boundaries there is nothing to fill — just render).
   * The viewport is not yet positioned (scrollTop=0), so loading does not compensate/trim. Plan A does not compensate
   * scrollTop anyway. gen guard drops batches overtaken by a newer jump.
   */
  private async fillAround(targetId: string | number, g: number): Promise<void> {
    const halfTh = this.threshold / 2;
    let upIter = 0;
    while (this.aboveTarget(targetId) < halfTh && !this.noOlder && this.mounted.length > 0) {
      const n = await this.loadOlderIntoFresh(g);
      upIter++;
      if (n === 0) break; // reached boundary / overtaken / no data
    }
    let downIter = 0;
    while (this.belowTarget(targetId) < halfTh && !this.noNewer && this.mounted.length > 0) {
      const n = await this.loadNewerIntoFresh(g);
      downIter++;
      if (n === 0) break;
    }
    let compIter = 0;
    if (this.totalH() < this.threshold) {
      const fillUp = this.noNewer && !this.noOlder;   // bottom reached → fill upward
      const fillDown = this.noOlder && !this.noNewer; // top reached → fill downward
      while (this.totalH() < this.threshold && (fillUp || fillDown) && this.mounted.length > 0) {
        const n = fillUp ? await this.loadOlderIntoFresh(g) : await this.loadNewerIntoFresh(g);
        compIter++;
        if (n === 0) break; // other side also reached boundary
      }
    }
    if (ngDevMode) console.log('[JUMP] fill iters up/down/comp=', upIter, downIter, compIter, 'totalH=', Math.round(this.totalH()));
  }

  /** Total height of all mounted entries above targetId (= topOf(targetIdx)). If the target is not in the window,
   *  treat everything as above. */
  private aboveTarget(targetId: string | number): number {
    const idx = this.indexOfId(targetId);
    return idx < 0 ? this.totalH() : this.topOf(idx);
  }
  /** Total height of all mounted entries below targetId (excluding the target itself). If the target is not in the
   *  window → 0. */
  private belowTarget(targetId: string | number): number {
    const idx = this.indexOfId(targetId);
    if (idx < 0) return 0;
    this.flushPrefix();
    return this.totalH() - this.prefix[idx + 1];
  }

  /** Load one older batch into the building window (no compensation / no trim / no revalidate — viewport not yet
   *  positioned); includes the old ghost reveal rebuild. Empty batch → noOlder. Returns the count mounted
   *  (0 = hit boundary / overtaken / no data). */
  private async loadOlderIntoFresh(g: number): Promise<number> {
    if (this.destroyed || g !== this.gen || this.noOlder || this.mounted.length === 0) return 0;
    const cursor = this.olderCursorId();
    const batch = await this.source.getOlder(cursor, this.cfg.mountItem);
    if (this.destroyed || g !== this.gen) return 0;
    const merged = this.mergeBatch(batch);
    if (merged.length === 0) { this.noOlder = true; return 0; }
    this.absorbBoundary(merged);
    const oldGhost = this.ghostEntry;
    this.mountBatch(merged, 'older');
    if (oldGhost && this.mounted.indexOf(oldGhost) > 0) { oldGhost.el.classList.remove('cb-ghost'); this.rebuildEntry(oldGhost); }
    this.measurePending();
    this.updateGhost();
    return merged.length;
  }
  /** Load one newer batch into the building window (append). Empty batch → noNewer. Returns the count mounted
   *  (0 = hit boundary / overtaken / no data). */
  private async loadNewerIntoFresh(g: number): Promise<number> {
    if (this.destroyed || g !== this.gen || this.noNewer || this.mounted.length === 0) return 0;
    const cursor = this.newerCursorId();
    const batch = await this.source.getNewer(cursor, this.cfg.mountItem);
    if (this.destroyed || g !== this.gen) return 0;
    const merged = this.mergeBatch(batch);
    if (merged.length === 0) { this.noNewer = true; return 0; }
    this.absorbBoundary(merged);
    // Authoritative: a newer batch reaches the global newest iff it carries the 'newest' marker. A full page WITHOUT it
    // means more newer data remains (a large WS backlog spans multiple pages) → noNewer=false so the next load continues.
    // absorbBoundary is sticky (only ever sets true), so without this a partial backlog page left the kernel falsely at
    // the newest, stranding the remaining newer messages off-window.
    this.noNewer = merged.some(it => it.boundary === 'newest' || it.boundary === 'both');
    this.mountBatch(merged, 'newer');
    // Reached the newest edge → (re)mount in-flight optimistic sends (getPending). loadNewerIntoFresh only runs when
    // !noNewer (the guard above), so the unmount branch cannot fire here — only the follow/fill path uses this.
    if (this.noNewer) this.elevatePending();
    this.measurePending();
    this.updateGhost();
    return merged.length;
  }

  /** Positioning math for a mounted idx (shared by scrollToIndex / openAround) — now an explicit item {@link Anchor}
   *  applied via {@link applyAnchor}. offset is recomputed from the alignment + current vh each call (a resize between
   *  calls is honored). */
  private positionMounted(idx: number, anchor: 'top' | 'center' | 'bottom'): void {
    const topOfIdx = this.topOf(idx);
    const h = this.mounted[idx].height;
    const offset = anchor === 'center' ? h / 2 - this.vh / 2 : anchor === 'bottom' ? h - this.vh : 0;
    this.applyAnchor({ mode: 'item', id: this.mounted[idx].item.id, offset, fallbackId: null });
    if (ngDevMode) console.log('[JUMP] positionMounted idx=', idx, 'id=', this.mounted[idx]?.item.id, 'topOf=', Math.round(topOfIdx), 'h=', Math.round(h), 'offset=', Math.round(offset), 'vh=', this.vh, '-> scrollTop=', Math.round(this.viewport.scrollTop));
  }

  /** Clear the window + reset all load/boundary state (called at the start of openAround). unmountAll already cleared
   *  mounted/prefix/pending/ghost. */
  private resetWindowState(): void {
    if (this.rafId) { cancelAnimationFrame(this.rafId); this.rafId = 0; }
    this.dirty = false;
    this.unmountAll();
    this.noOlder = false;
    this.noNewer = false;
    this.inflightOlder = false;
    this.inflightNewer = false;
    this.lastScrollTop = 0;
    this.resetting = true;
    this.shifting = true;
    this.viewport.scrollTop = 0; // content is empty, reset to zero
    this.shifting = false;
    this.updateTailCap(); // window emptied → hide the cap (mounted.length === 0 → height 0) until the new batch mounts
  }

  /** Add a one-shot highlight flash to the target entry (animationend removes the class; a forced reflow guarantees
   *  the animation restarts on repeated jumps). */
  private flashHighlight(idx: number): void {
    const el = this.mounted[idx]?.el;
    if (!el) return;
    el.classList.remove('cb-jump-highlight');
    void el.offsetWidth; // force reflow → restart the animation
    el.classList.add('cb-jump-highlight');
    el.addEventListener('animationend', () => el.classList.remove('cb-jump-highlight'), { once: true });
  }

  getInfo(): CbScrollInfo {
    return {
      scrollTop: Math.round(this.viewport.scrollTop),
      scrollHeight: Math.round(this.content.scrollHeight),
      viewportHeight: this.vh,
      oldestId: this.mounted[0]?.item.id ?? null,
      newestId: this.mounted.length > 0 ? this.mounted[this.mounted.length - 1].item.id : null,
      mounted: this.mounted.length,
      atTop: this.mounted.length > 0 && this.viewport.scrollTop <= 0,
      atBottom: this.mounted.length > 0 && this.isAtBottom(),
      noOlder: this.noOlder,
      noNewer: this.noNewer,
    };
  }

  refresh(): void {
    this.measureVh();
    if (this.rafId) { cancelAnimationFrame(this.rafId); this.rafId = 0; }
    this.dirty = false;
    this.balance();
  }

  flushViewportResize(): void {
    // Apply a resize that was deferred during an immunity frame. Re-check isFrozen so a thaw that
    // races with a re-freeze (back-to-back transitions) does not prematurely flush.
    if (this.resizeDeferred && !this.destroyed && !this.isFrozen()) {
      this.resizeDeferred = false;
      this.onViewportResize();
    }
  }

  destroy(): void {
    this.destroyed = true;
    cancelAnimationFrame(this.rafId);
    cancelAnimationFrame(this.vvRafId); this.vvRafId = 0;
    window.visualViewport?.removeEventListener('resize', this.onVisualViewportChange);
    window.visualViewport?.removeEventListener('scroll', this.onVisualViewportChange);
    this.viewportObs.disconnect();
    this.tailCapObs.disconnect();
    this.viewport.removeEventListener('scroll', this.onNativeScroll);
    this.unmountAll();
    if (this.tailCapEl) { this.tailCapEl.remove(); this.tailCapEl = null; } // cap persists across re-seed; torn down only here
    this.source.destroy();
  }

  // ---------- Prefix sum / height ----------

  /** Recompute prefix when dirty (O(n), n = mounted.length). mount/unmount/onElHeight mark it dirty; call before reading prefix. */
  private flushPrefix(): void {
    if (!this.dirtyPrefix) return;
    const p = [0];
    let acc = 0;
    for (const e of this.mounted) { acc += e.height; p.push(acc); }
    this.prefix = p;
    this.dirtyPrefix = false;
  }

  /** Distance from the top of idx to the content top = Σ older-neighbor heights = prefix[idx]. */
  private topOf(idx: number): number { this.flushPrefix(); return this.prefix[idx] ?? 0; }

  // totalH adds tailCapH (the cap is below every real item, so it never enters prefix[]/topOf — only the total). prefix
  // stays real-items-only; this keeps belowTarget/atBottom honest (the cap really is below the last real item) and topOf exact.
  private totalH(): number { this.flushPrefix(); return (this.prefix.length > 0 ? this.prefix[this.prefix.length - 1] : 0) + this.tailCapH; }

  // ---------- Mounting (array index; DOM follows mounted order, no scrollTop involvement) ----------

  /** mergeItems hook (default noop). Called once per source batch, before createItem. scope = batch. */
  private mergeBatch(batch: CbItem<T>[]): CbItem<T>[] {
    return this.hooks.mergeItems ? this.hooks.mergeItems(batch) : batch;
  }

  /**
   * Mount one batch (already merged): side = init/older → prepend (front of mounted, DOM inserted before the old head);
   * newer → append (end). older does not measure internally (loadOlder does the unified measure + ghost rebuild);
   * init/newer measure at the end. prev = the older neighbor: the previous one within the batch (ascending), or the
   * old tail on append.
   */
  private mountBatch(merged: CbItem<T>[], side: 'init' | 'older' | 'newer', animate = false): void {
    // merged already passed through the mergeItems hook (per-batch) by the caller; this method only mounts.
    if (merged.length === 0) return;
    if (side === 'newer') {
      for (let i = 0; i < merged.length; i++) {
        const prev = i > 0 ? merged[i - 1] : (this.mounted.length > 0 ? this.mounted[this.mounted.length - 1].item : null);
        this.mounted.push(this.createEntry(merged[i], prev, undefined, animate));
      }
    } else { // init / older both prepend (when init, mounted is empty, anchorEl = null -> appendChild)
      const anchorEl = this.mounted.length > 0 ? this.mounted[0].el : null;
      const fresh: Entry<T>[] = [];
      for (let i = 0; i < merged.length; i++) {
        const prev = i > 0 ? merged[i - 1] : null;
        fresh.push(this.createEntry(merged[i], prev, anchorEl)); // prepended history never animates
      }
      this.mounted.unshift(...fresh);
    }
    this.dirtyPrefix = true;
    if (side !== 'older') this.measurePending();
    this.updateTailCap(); // re-measure the cap every batch mount: a newer batch reaching the global newest flips loading→gap
  }

  /** Single source of truth for the skeleton-vs-real decision (mirrors Plan B's createVs). A slot is a skeleton iff it
   *  is the topmost item (prev === null) AND the global oldest has NOT been reached. atOldestEdge covers boundary
   *  'oldest', 'both', and the kernel's noOlder — the noOlder case keeps an optimistic send in an EMPTY thread real (no
   *  boundary marker, but noOlder=true → not a skeleton). When the slot is a skeleton and createSkeleton is supplied,
   *  use it; otherwise fall back to createItem. */
  private createVs(item: CbItem<T>, prev: CbItem<T> | null): CbElement<T> {
    const atOldestEdge = item.boundary === 'oldest' || item.boundary === 'both' || this.noOlder;
    const skeleton = prev === null && !atOldestEdge;
    return skeleton && this.hooks.createSkeleton ? this.hooks.createSkeleton(item) : this.hooks.createItem(item, prev);
  }

  /** Create and mount one entry: createItem + DOM insert (before anchorEl / append) + pendingMeasure + subscribe to height.
   *  `animate` (default false) marks a mount that should play cb-enter after its height settles — only insertAfter and
   *  appendLive pass true; scroll-loaded history batches (init/older/newer) never animate. */
  private createEntry(item: CbItem<T>, prev: CbItem<T> | null, anchorEl?: HTMLElement | null, animate = false): Entry<T> {
    if (ngDevMode) this.mountTick++;
    const vs = this.createVs(item, prev);
    const el = vs.el;
    el.dataset['cbId'] = String(item.id);
    if (anchorEl !== undefined && anchorEl !== null) this.content.insertBefore(el, anchorEl);
    else if (this.tailCapEl) this.content.insertBefore(el, this.tailCapEl); // append path: keep the tail cap always last
    else this.content.appendChild(el);
    const entry: Entry<T> = { item, el, vs, height: 0, unsub: () => {}, transient: false, optimistic: false, resortTarget: false, animate, enterAbove: false, leaving: false, leaveDone: false }; // real height set by measurePending()
    el.classList.add('cb-pending');
    this.pendingMeasure.push(entry);
    this.mounting = true; // suppress the first report (same as id-based)
    entry.unsub = vs.onHeightChange(h => this.onElHeight(entry, h));
    this.mounting = false;
    return entry;
  }

  /**
   * Rebuild a mounted entry in place: re-runs createItem with the current real prev (mounted[idx-1], the older
   * neighbor), replaces the DOM in place (insertBefore(newEl,oldEl) + removeChild(oldEl)), migrates the subscription,
   * and pushes to pendingMeasure.
   * **Lightweight**: does not measurePending — loadOlder does one unified measure after "mount new batch + ghost reveal".
   * Plan A never compensates scrollTop (the browser's overflow-anchor pins the viewport).
   * Use case: skeleton reveal (the old mounted[0] shifts down after a prepend, prev changes from null to non-null, so
   * group-head / date must be recomputed).
   */
  /**
   * Rebuild a mounted entry in place: re-runs createItem with the current real prev (mounted[idx-1], the older neighbor),
   * replaces the DOM in place (insertBefore(newEl,oldEl)+removeChild(oldEl)), migrates the subscription. When `newItem`
   * is given (settle: optimistic->confirmed) the entry's item is replaced too; otherwise (ghost reveal) the item is
   * unchanged. **Lightweight**: does not measurePending -- loadOlder does one unified measure after "mount new batch +
   * ghost reveal". Plan A never compensates scrollTop (browser overflow-anchor pins the viewport). Never sets `animate`
   * (a rebuild reuses an already-visible slot; no cb-enter).
   */
  private rebuildEntry(entry: Entry<T>, newItem: CbItem<T> = entry.item): void {
    const idx = this.mounted.indexOf(entry);
    if (idx < 0) return;
    if (ngDevMode) this.mountTick++;
    const newPrev = idx > 0 ? this.mounted[idx - 1].item : null; // older neighbor (one index lower)
    const newVs = this.createVs(newItem, newPrev);
    const newEl = newVs.el;
    newEl.dataset['cbId'] = String(newItem.id);
    this.content.insertBefore(newEl, entry.el);
    this.content.removeChild(entry.el);
    entry.unsub();
    entry.vs = newVs;
    entry.el = newEl;
    entry.item = newItem; // no-op for ghost reveal (same ref); replaces item for settle
    entry.height = 0; // real height set by measurePending() (loadOlder measures after rebuild)
    newEl.classList.add('cb-pending');
    this.pendingMeasure.push(entry);
    this.mounting = true;
    entry.unsub = newVs.onHeightChange(h => this.onElHeight(entry, h));
    this.mounting = false;
    this.dirtyPrefix = true;
  }

  /** Unmount the oldest (mounted[0], DOM top). */
  private unmountTop(): boolean {
    if (this.mounted.length === 0) return false;
    const e = this.mounted[0];
    e.unsub();
    if (e.el.parentNode === this.content) this.content.removeChild(e.el);
    e.vs.destroy();
    this.mounted.shift();
    if (ngDevMode) this.unmountTick++;
    this.dirtyPrefix = true;
    return true;
  }

  /** Unmount the newest (mounted last, DOM bottom). */
  private unmountBot(): boolean {
    if (this.mounted.length === 0) return false;
    const e = this.mounted[this.mounted.length - 1];
    e.unsub();
    if (e.el.parentNode === this.content) this.content.removeChild(e.el);
    e.vs.destroy();
    this.mounted.pop();
    if (ngDevMode) this.unmountTick++;
    this.dirtyPrefix = true;
    return true;
  }

  /** Unmount the entry at an arbitrary index (used by removeItem's exit-animation completion). Plan A does not
   *  compensate scrollTop (browser overflow-anchor pins the viewport). */
  private unmountAt(i: number): boolean {
    if (i < 0 || i >= this.mounted.length) return false;
    const e = this.mounted[i];
    e.unsub();
    if (e.el.parentNode === this.content) this.content.removeChild(e.el);
    e.vs.destroy();
    this.mounted.splice(i, 1);
    if (ngDevMode) this.unmountTick++;
    this.dirtyPrefix = true;
    return true;
  }

  /** Cancel any in-flight enter/leave/move animation on an entry being force-unmounted (jump re-seed / destroy).
   *  Each animation has TWO in-flight states — rAF-pending (the kickoff frame hasn't fired; class not added) and
   *  timer-running (rAF fired; the CSS animation is playing). The TIMER is the authoritative "running" signal, so it is
   *  checked FIRST: in the unit-test rAF spy the kickoff fires synchronously and returns 0, which leaves enterRaf/leaveRaf/
   *  moveRaf holding a stale 0 ALONGSIDE a set timer — checking the rAF first would take the wrong branch and leave the
   *  timer to double-decrement `animating` via its safety timeout. Timer-first resolves correctly in both envs (a truly
   *  pending rAF has its timer still undefined). `animating` is decremented exactly once per animation. */
  private cancelEntryAnim(entry: Entry<T>): void {
    if (entry.enterTimer !== undefined) {
      clearTimeout(entry.enterTimer); entry.enterTimer = undefined;
      entry.el.classList.remove('cb-enter', 'cb-enter-above'); // an entry plays exactly one of the two enter classes
      this.animating--;
    } else if (entry.enterRaf !== undefined) {
      cancelAnimationFrame(entry.enterRaf); entry.enterRaf = undefined;
      entry.el.classList.remove('cb-pending', 'cb-enter', 'cb-enter-above'); // cb-pending was held for the enter rAF
      this.animating--;
    }
    if (entry.leaveTimer !== undefined) {
      clearTimeout(entry.leaveTimer); entry.leaveTimer = undefined;
      entry.leaveDone = true; entry.el.classList.remove('cb-leave');
      this.animating--;
    } else if (entry.leaveRaf !== undefined) {
      cancelAnimationFrame(entry.leaveRaf); entry.leaveRaf = undefined;
      entry.leaveDone = true; entry.el.classList.remove('cb-leave'); // mark consumed so a stale rAF can't double-decrement
      this.animating--;
    } else if (entry.leaving && !entry.leaveDone) {
      // Defensive: leaving flagged but neither branch above matched (e.g. leave completed between scheduling and here).
      entry.leaveDone = true; entry.el.classList.remove('cb-leave');
      this.animating--;
    }
    if (entry.moveTimer !== undefined) {
      clearTimeout(entry.moveTimer); entry.moveTimer = undefined;
      entry.el.classList.remove('cb-move');
      entry.el.style.removeProperty('--cb-move-dy');
      this.animating--;
    } else if (entry.moveRaf !== undefined) {
      cancelAnimationFrame(entry.moveRaf); entry.moveRaf = undefined;
      entry.el.classList.remove('cb-move');
      entry.el.style.removeProperty('--cb-move-dy');
      this.animating--;
    }
  }

  private unmountAll(): void {
    for (const e of this.mounted) {
      this.cancelEntryAnim(e);
      if (e.el.parentNode === this.content) this.content.removeChild(e.el);
      e.vs.destroy();
    }
    this.mounted = [];
    this.prefix = [0];
    this.dirtyPrefix = true;
    this.pendingMeasure = [];
    this.ghostEntry = null;
  }

  /**
   * Sync skeleton state (pure class): skeleton = mounted[0] (the oldest mounted item) when "not yet at the global
   * oldest". Compared by entry reference (immune to array shifts); when it changes, the old ghost loses cb-ghost and
   * the new ghost gains it. The ghost-reveal rebuild is done explicitly by loadOlder after mounting the new batch
   * (folded into the unified measure). When noOlder, target is null and stays gone permanently.
   */
  private updateGhost(): void {
    const target = !this.noOlder && this.mounted.length > 0 ? this.mounted[0] : null;
    if (target === this.ghostEntry) return;
    this.ghostEntry?.el.classList.remove('cb-ghost');
    target?.el.classList.add('cb-ghost');
    this.ghostEntry = target;
  }

  /**
   * Sync the tail cap (class toggle + MEASURED height), mirroring {@link updateGhost} at the newer edge. The cap is a
   * persistent non-message element kept as the last child of content (never in mounted[]), so it never corrupts the newer
   * cursor (mounted[last].item.id) and never shifts a real item's topOf. Mode:
   *  - mounted empty → hidden (height 0): no lone spinner during the empty first load / re-seed.
   *  - noNewer       → gap: a small spacer below the last message (breathing room above the input bar).
   *  - !noNewer      → loading: the same centered spinner as the top ghost (cb-tail-cap--loading).
   * Height is READ via offsetHeight, never assumed — CSS owns the dimension (gap/spinner size), the kernel measures it so
   * totalH stays exact even if the CSS is later tuned. Called at the end of every mountBatch (a newer batch reaching the
   * global newest flips loading→gap and genuinely changes the height) and on resize via tailCapObs. Plan A does not
   * compensate scrollTop (browser overflow-anchor pins the viewport); in either case the cap sits below every real item,
   * so a height change moves nothing above it.
   */
  private updateTailCap(): void {
    const el = this.tailCapEl;
    if (!el) return;
    const mode: 'hidden' | 'gap' | 'loading' = this.mounted.length === 0 ? 'hidden' : this.noNewer ? 'gap' : 'loading';
    el.classList.toggle('cb-tail-cap--gap', mode === 'gap');
    el.classList.toggle('cb-tail-cap--loading', mode === 'loading');
    this.tailCapH = el.offsetHeight;
  }

  // ---------- balance: checkpoint + loading (no compensation) ----------

  /** Viewport resized (soft keyboard open/close, orientation change, window resize). Reflow, not a checkpoint:
   *  re-measure vh and keep the reading position. Was-at-bottom → re-pin and skip load/trim (a shrink-triggered
   *  balance is jitter); mid-screen → scheduleBalance is a no-op unless at an edge. Content-driven rebalances still
   *  run via onElHeight + onNativeScroll. */
  private onViewportResize(): void {
    if (this.destroyed) return;
    // Immunity frame: a route-transition animation is in flight. Hold the current pin so the
    // message list does not jump under the sliding overlay; flushViewportResize runs this once on thaw.
    if (this.isFrozen()) { this.resizeDeferred = true; return; }
    const anchor = this.captureAnchor();      // BEFORE measureVh (at-bottom test uses the OLD vh + kernel totalH)
    this.measureVh();                          // apply the new vh
    if (anchor.mode === 'bottom' && this.mounted.length > 0) {
      this.applyAnchor(anchor);                // re-pin to the new bottom (new vh)
      this.suppressScrollBalance = true;  // swallow the async scroll event the pin fires (no load/trim at bottom)
      return;
    }
    this.scheduleBalance();
  }

  private onNativeScroll = () => {
    if (this.shifting || this.destroyed) return;
    if (this.suppressScrollBalance) { this.suppressScrollBalance = false; return; }  // consume the reflow-pin's scroll event
    this.scheduleBalance();
  };

  private scheduleBalance(): void {
    if (this.dirty || this.destroyed) return;
    // An enter/exit animation is in flight: hold the checkpoint until it drains. Mount/unmount ops still proceed
    // (each manages `animating`), so concurrent add+remove keep animating — only the load/trim checkpoint waits.
    if (this.animating > 0) { this.deferBalance = true; return; }
    this.dirty = true;
    this.rafId = requestAnimationFrame(() => { this.dirty = false; this.balance(); });
  }

  /** Animation completion drain (called from every enter/exit animationend). When the last one finishes, fire the
   *  balance that was deferred while animating>0. */
  private onAnimEnd(): void {
    if (this.animating > 0) this.animating--;
    if (this.animating === 0 && this.deferBalance && !this.destroyed) {
      this.deferBalance = false;
      this.scheduleBalance();
    }
  }

  /** Play the cb-enter mount animation on a freshly-measured entry. cb-pending is STILL on (measurePending left it for
   *  animated entries); the kickoff is pushed to the next requestAnimationFrame so the browser commits the pre-state
   *  first, then the rAF atomically drops cb-pending and adds the enter class — the first painted frame is the
   *  @keyframes `from` (opacity:0), with no one-frame flash at the un-hidden natural state.
   *
   *  `animating` is bumped when the rAF is scheduled and decremented exactly once by: animationend, the safety timeout,
   *  OR cancelEntryAnim cancelling the rAF / clearing enterTimer. enterRaf (rAF pending) and enterTimer (rAF fired,
   *  animation running) are mutually exclusive. */
  private enterAnim(entry: Entry<T>, cls: 'cb-enter' | 'cb-enter-above' = 'cb-enter'): void {
    if (entry.enterRaf !== undefined && entry.enterTimer === undefined) { cancelAnimationFrame(entry.enterRaf); entry.enterRaf = undefined; this.animating--; }
    this.animating++;
    entry.enterRaf = requestAnimationFrame(() => {
      entry.enterRaf = undefined;
      if (this.destroyed) { this.onAnimEnd(); return; } // torn down mid-frame → balance animating, no DOM write
      entry.el.classList.remove('cb-pending');
      entry.el.classList.add(cls);
      const finish = (): void => {
        if (entry.enterTimer === undefined) return;
        clearTimeout(entry.enterTimer); entry.enterTimer = undefined;
        entry.el.classList.remove(cls);
        this.onAnimEnd();
      };
      entry.enterTimer = setTimeout(finish, ANIM_SAFETY_MS); // safety if animationend is swallowed
      entry.el.addEventListener('animationend', finish, { once: true });
    });
  }

  private async balance(): Promise<void> {
    if (this.destroyed || this.mounted.length === 0) return;
    if (ngDevMode && this.closeCheckpoint) return; // debug: turn off the mount checkpoint (no loadOlder/loadNewer; removed in prod AOT)
    const t0 = ngDevMode ? performance.now() : 0;
    const m0 = this.mountTick, u0 = this.unmountTick;
    const st = this.viewport.scrollTop;
    const dir = this.scrollDir(st);
    this.lastScrollTop = st;

    const total = this.totalH();
    const atTop = st < this.cfg.edge;
    const atBottom = total - this.vh - st < this.cfg.edge;

    if (atTop && dir !== 'down' && !this.noOlder) { await this.loadOlder(); this.trimNewer(); }
    else if (atBottom && dir !== 'up' && !this.noNewer) { await this.loadNewer(); await this.reconcileOptimistic(); this.trimOlder(); }

    if (ngDevMode && this.onDebug) {
      this.onDebug({
        ms: performance.now() - t0, mount: this.mountTick - m0, unmount: this.unmountTick - u0,
        scrollTop: Math.round(st), oldestId: this.mounted[0]?.item.id ?? null, newestId: this.mounted.length > 0 ? this.mounted[this.mounted.length - 1].item.id : null,
        inflightOlder: this.inflightOlder, inflightNewer: this.inflightNewer,
      });
    }
    this.emit();
  }

  /**
   * Load older: getOlder (cursor = olderCursorId(), the oldest non-transient mounted item) + mergeItems + prepend mount
   *  + old-ghost (the former mounted[0]) reveal rebuild. Plan A **does not compensate scrollTop** (the browser's
   *  overflow-anchor pins the viewport); the ghost reveal and the new batch share one measure. absorbBoundary is called
   *  only after revalidate passes (prevents a fling-back from falsely locking noOlder → the oldest batch never mounting).
   */
  private async loadOlder(): Promise<void> {
    if (this.inflightOlder || this.noOlder || this.mounted.length === 0) return;
    this.inflightOlder = true;
    const g = this.gen;
    try {
      const cursor = this.olderCursorId();
      const batch = await this.source.getOlder(cursor, this.cfg.mountItem);
      if (this.destroyed || g !== this.gen) return; // jump re-seed overtook → drop the in-flight batch
      if (!this.revalidateTop()) return; // fling reversed during the await → do not mount or absorb (phase 0: absorb boundary only after revalidate passes)
      const merged = this.mergeBatch(batch);
      if (this.destroyed || merged.length === 0) { if (merged.length === 0) this.noOlder = true; return; }
      this.absorbBoundary(merged); // phase 0: absorb boundary only after passing
      const oldGhost = this.ghostEntry;
      this.mountBatch(merged, 'older'); // prepend (no internal measure)
      // Old ghost reveal rebuild (position unchanged, recomputes group-head/date with the new prev), sharing one measure with the new batch.
      if (oldGhost && this.mounted.indexOf(oldGhost) > 0) {
        oldGhost.el.classList.remove('cb-ghost'); // must happen before rebuild swaps the el
        this.rebuildEntry(oldGhost);
      }
      this.measurePending(); // one unified measure: new batch + ghost reveal (Plan A does not compensate)
      this.updateGhost();
    } finally {
      this.inflightOlder = false;
    }
    this.emit();
  }

  /** Load ONE newer batch: getNewer + mergeItems, then a mount-dispatch. **Pure load — no trim** (split: the caller —
   *  balance / onMessageSignal — trims + reconciles). Returns the count mounted (0 = boundary / overtaken / no data). */
  private async loadNewer(force = false): Promise<number> {
    if (this.inflightNewer || this.mounted.length === 0) return 0;
    if (!force && this.noNewer) return 0;
    this.inflightNewer = true;
    const g = this.gen;
    let batch: CbItem<T>[];
    try {
      // No real cursor exists when the window is entirely optimistic/transient (the first send in an empty thread):
      // newerCursorId() would then fall back to an optimistic/transient id, which getNewer cannot resolve (returns []),
      // stranding the confirmed real off-window and leaving the bubble "sending" forever. Fetch the newest page
      // directly via init(-1, …) — the canonical "newest N items" op — which resolves from the live-cached reals.
      const hasReal = this.mounted.some(e => !e.transient && !e.optimistic && !e.leaving && !e.resortTarget);
      batch = hasReal
        ? await this.source.getNewer(this.newerCursorId(), this.cfg.mountItem)
        : await this.source.init(-1, this.cfg.mountItem, 0, this.initOpts);
      if (this.destroyed || g !== this.gen) return 0;
    } finally {
      this.inflightNewer = false;
    }
    if (this.destroyed || g !== this.gen) return 0;
    if (batch.length === 0) { this.noNewer = true; return 0; }
    if (!force && !this.revalidateBottom()) return 0;
    const wasAtNewest = this.noNewer;                        // pre-load edge state (transition gate for the optimistic dispatch)
    this.absorbBoundary(batch);
    // Authoritative: a newer batch reaches the global newest iff it carries the 'newest' marker. A full page WITHOUT it
    // means more newer data remains (a large WS backlog spans multiple pages) → noNewer=false so the next load continues.
    // absorbBoundary is sticky (only ever sets true), so without this a partial backlog page left the kernel falsely at
    // the newest, stranding the remaining newer messages off-window.
    this.noNewer = batch.some(it => it.boundary === 'newest' || it.boundary === 'both');

    const count0 = this.mounted.length;
    // The batch is reals only — in-flight optimistic sends are mounted separately at the newest edge via elevatePending.
    this.mountNewerReals(this.mergeBatch(batch));
    // Symmetric optimistic lifecycle — (re)mount at the newest edge; unmount when a push extended the newest
    // (wasAtNewest && !noNewer). Recoverable via getPending on returning to the newest.
    if (this.noNewer) this.elevatePending();
    else if (wasAtNewest) this.unmountAllOptimistic();
    this.dirtyPrefix = true;
    this.measurePending();
    this.updateGhost();
    this.updateTailCap();
    this.emit();
    return this.mounted.length - count0;
  }

  /**
   * (Re)mount in-flight optimistic sends at the global newest edge (mirror of Plan B). Driven by source.getPending();
   * a pending matching a mounted transient is promoted (transient→optimistic), one already mounted is skipped, one not
   * mounted is appended at the tail as optimistic. No-op in the common case (insertAfter pre-mounts for display).
   */
  private elevatePending(): void {
    for (const p of this.source.getPending()) {
      const idx = this.indexOfClientMsgId(p.clientMessageId);
      if (idx >= 0) {
        const e = this.mounted[idx];
        if (e.transient) { e.transient = false; e.optimistic = true; } // promote
      } else {
        const tail = this.mounted.length > 0 ? this.mounted[this.mounted.length - 1].item : null;
        const entry = this.createEntry(p, tail, undefined, true);
        entry.optimistic = true;
        this.mounted.push(entry);
      }
    }
  }

  /**
   * Remove every in-flight optimistic send (mirror of Plan B). Called when a push extended the newest (noNewer
   * true→false). Not lost — re-mounted by elevatePending on returning to the newest. Synchronous (no cb-leave);
   * iterate downward. Plan A relies on overflow-anchor (no manual scrollTop compensation).
   */
  private unmountAllOptimistic(): void {
    let removed = false;
    for (let i = this.mounted.length - 1; i >= 0; i--) {
      if (this.mounted[i].optimistic) { this.unmountAt(i); removed = true; }
    }
    if (removed) this.dirtyPrefix = true;
  }

  /** Mount real items before the optimistic/transient tail block (mirror of Plan B; Plan A adds no scrollTop compensation). */
  private mountNewerReals(reals: CbItem<T>[]): void {
    if (reals.length === 0) return;
    // Insertion point = right after the last real entry (the cursor). When NO real is mounted — the window is entirely
    // optimistic/transient, i.e. the first confirm in an empty thread — default to 0 so the new real becomes the
    // first/oldest entry with prev=null (correct group-head flags + cb-enter-above), rather than appending it after the
    // optimistic block where its prev would be the transient it is about to replace.
    let insertIdx = 0;
    for (let i = this.mounted.length - 1; i >= 0; i--) {
      const e = this.mounted[i];
      if (!e.transient && !e.optimistic && !e.leaving && !e.resortTarget) { insertIdx = i + 1; break; }
    }
    // A trailing optimistic/transient block sits after the insert point. When it does, every new real enters FROM ABOVE
    // (cb-enter-above): it descends into its slot from the newest-real side so it never travels DOWN through the pending
    // band (a downward cb-enter would visually cover the pending mid-animation). The tail simultaneously shoves down via
    // cb-move (onMessageSignal). Without a tail, cb-enter (from below) is the natural "message arrives" motion.
    const enterAbove = insertIdx < this.mounted.length;
    const absorb = this.hooks.absorbTail; // null when no hook is wired (the app supplies album/domain knowledge here)
    for (const item of reals) {
      // Confirm by clientMessageId: the real carries a fresh server id (≠ the optimistic's clientMessageId-as-id),
      // so the pair is matched by clientMessageId, not id. No clientMessageId → a plain incoming message.
      const confirm = this.indexOfClientMsgId(item.clientMessageId) >= 0;
      if (!confirm && this.indexOfId(item.id) >= 0) continue;

      // Cross-batch album absorb (mirrors Kernel B): a non-confirm item the hook folds into the running newest real
      // (`target` = mounted[insertIdx-1]). Morphs target in place — no new bubble, insertIdx unchanged — so a run of
      // absorbable items all fold into it; the first non-absorbable item mounts normally and ends the run. Confirms are
      // excluded. Plan A adds no scrollTop compensation on the morph (overflow-anchor pins the viewport).
      if (!confirm && absorb && insertIdx > 0) {
        const target = this.mounted[insertIdx - 1];
        if (target && !target.optimistic && !target.transient && !target.leaving && !target.resortTarget) {
          const merged = absorb(target.item, item);
          if (merged !== null) {
            this.measuring = true;
            target.item = merged;
            const tp = insertIdx > 1 ? this.mounted[insertIdx - 2].item : null;
            target.vs.update(merged, tp);
            const h = target.el.offsetHeight;
            if (h !== target.height) { target.height = h; this.dirtyPrefix = true; }
            this.measuring = false;
            continue;
          }
        }
      }

      const anchorEl = insertIdx < this.mounted.length ? this.mounted[insertIdx].el : null;
      const prev = insertIdx > 0 ? this.mounted[insertIdx - 1].item : null;
      // A confirm (matches an in-flight optimistic by clientMessageId) takes the optimistic's slot — same id, same
      // position — so it does NOT play a cb-enter: the bubble is already on screen as the optimistic; only the
      // cb-confirmed spinner→check choreography should play (reconcileOptimistic tags it). A plain incoming real (no
      // optimistic counterpart) DOES animate — enterAbove when a tail is present, else cb-enter from below.
      const entry = this.createEntry(item, prev, anchorEl, !confirm);
      entry.enterAbove = enterAbove;
      if (confirm) { entry.resortTarget = true; }
      this.mounted.splice(insertIdx, 0, entry);
      insertIdx++;
    }
    this.dirtyPrefix = true;
  }

  /** Optimistic-confirm reconciliation (mirror of Plan B; Plan A relies on overflow-anchor — no manual scrollTop
   *  compensation on removal). Synchronous: for each real flagged resortTarget, remove the optimistic duplicate and tag
   *  the real cb-confirmed. The slide animation is owned elsewhere — the real's cb-enter-above plays at mount in
   *  measurePending, and the surviving tail's cb-move shove plays in onMessageSignal after this returns — so this pass
   *  only does the synchronous duplicate removal + tag, run within the loadNewer→reconcile microtask so the swap is never
   *  painted as two bubbles. No-op when there are no resortTargets. */
  private async reconcileOptimistic(): Promise<void> {
    const targets = this.mounted.filter(e => e.resortTarget);
    if (targets.length === 0) return;
    this.resorting = true;
    try {
      const pairs: { source: Entry<T>; target: Entry<T> }[] = [];
      for (const target of targets) {
        // Pair by clientMessageId (the real's fresh server id ≠ the optimistic's id → not id-matchable; and indexOfId
        // would return the target itself since the real is mounted BEFORE the optimistic source).
        const si = this.indexOfClientMsgId(target.item.clientMessageId);
        if (si >= 0) pairs.push({ source: this.mounted[si], target });
      }
      if (pairs.length === 0) {
        // No source mounted (e.g. a jump during pending unmounted it): the real is already visible — just tag it.
        for (const t of targets) { t.resortTarget = false; t.el.classList.add('cb-confirmed'); }
        return;
      }
      this.flushPrefix();
      // Remove each optimistic source (the duplicate) — Plan A: overflow-anchor pins the viewport (no manual compensation).
      // The real's enter (cb-enter-above, already started in measurePending) and the tail shove (cb-move, onMessageSignal)
      // are the visible motion; this synchronous removal just clears the duplicate before paint (no two-bubble flash).
      for (const source of pairs.map(p => p.source)) {
        const i = this.mounted.indexOf(source);
        if (i < 0) continue;
        this.unmountAt(i);
      }
      // The real is already visible — the cb-confirmed tag alone gates the spinner→check→fade choreography on these reals.
      for (const target of pairs.map(p => p.target)) {
        target.resortTarget = false;
        target.el.classList.add('cb-confirmed');
      }
      this.dirtyPrefix = true;
      this.measurePending();
    } finally {
      this.resorting = false;
    }
    this.emit();
  }

  /**
   * Re-sync the mounted optimistic/pending entries to the source's current `getPending()` snapshot. The caller mutates
   * the pending store first (e.g. the source marks a send failed and sinks it to the end) THEN calls this, so the
   * source stays the single owner of pending order/status and the kernel only reflects it.
   *
   * For each mounted optimistic entry (a contiguous tail block), matched to `fresh` by clientMessageId:
   *  - status change (new data ref) → morphed IN PLACE via `vs.update` (no remount — preserves the DOM node so a FLIP
   *    move can animate it);
   *  - order change → the optimistic tail block is reordered (mounted[] + DOM) to match `fresh`;
   *  - then EVERY entry whose absolute top changed (the mover AND any sibling shoved up/down by it) is FLIP-animated
   *    (cb-move) from its old top to its new top.
   *
   * Synchronous body (no I/O — a pure re-read of getPending); declared async to match reconcileOptimistic's shape so
   * callers can `await` it uniformly. Status-morph height deltas are folded into prefix under the `measuring` guard.
   * Plan A needs no scrollTop compensation for the reorder: a pure reorder within the optimistic tail leaves total
   * height and all above-viewport positions invariant, and the transform is visual-only so overflow-anchor is undisturbed.
   *
   * Skips fresh ids not currently mounted (new sends mount via insertAfter) and mounted optimistic not in fresh (removal
   * is reconcileOptimistic's job on confirm) — both are no-ops here.
   */
  async reconcilePending(): Promise<void> {
    if (this.destroyed || this.resetting) return;
    const fresh = this.source.getPending();

    // Optimistic entries form a contiguous tail block; collect the non-leaving ones (leaving ones are mid-exit).
    const suffix: Entry<T>[] = [];
    for (let i = this.mounted.length - 1; i >= 0; i--) {
      const e = this.mounted[i];
      if (!e.optimistic) break;
      if (!e.leaving) suffix.unshift(e);
    }
    if (suffix.length === 0) return;

    // 1. Capture the OLD absolute top of EVERY suffix entry before any mutation (a shoved sibling must animate too, not
    //    only the explicit mover). Keyed by entry ref — indices shift once we splice.
    this.flushPrefix();
    const oldTop = new Map<Entry<T>, number>();
    for (const e of suffix) oldTop.set(e, this.topOf(this.mounted.indexOf(e)));

    // 2. Morph: swap in the fresh item (new data ref ⇒ status changed) where the clientMessageId matches.
    const freshByCid = new Map<string, CbItem<T>>();
    for (const f of fresh) if (f.clientMessageId !== undefined) freshByCid.set(f.clientMessageId, f);
    for (const e of suffix) {
      const f = e.item.clientMessageId !== undefined ? freshByCid.get(e.item.clientMessageId) : undefined;
      if (f && f !== e.item) e.item = f;
    }

    // 3. Reorder mounted[] + DOM so the suffix matches `fresh` order (only optimistic entries move; reals/transients
    //    above stay put). desired = the suffix entries ordered by their position in fresh (defensively keeps any suffix
    //    entry not found in fresh at the end so nothing is dropped).
    const used = new Set<Entry<T>>();
    const desired: Entry<T>[] = [];
    for (const f of fresh) {
      if (f.clientMessageId === undefined) continue;
      const e = suffix.find(x => x.item.clientMessageId === f.clientMessageId);
      if (e && !used.has(e)) { desired.push(e); used.add(e); }
    }
    for (const e of suffix) if (!used.has(e)) desired.push(e);
    const reordered = desired.some((e, i) => e !== suffix[i]);
    if (reordered) {
      const suffixSet = new Set(suffix);
      const rest = this.mounted.filter(e => !suffixSet.has(e));
      this.mounted = [...rest, ...desired];
      for (const e of desired) {
        if (this.tailCapEl) this.content.insertBefore(e.el, this.tailCapEl); // keep the cap always last
        else this.content.appendChild(e.el);
      }
      this.dirtyPrefix = true;
    }

    // 4. Apply data + grouping in place (prev is final now) and fold any status-morph height delta synchronously under
    //    the measuring guard so prefix stays honest.
    this.flushPrefix();
    this.measuring = true;
    for (const e of suffix) {
      const idx = this.mounted.indexOf(e);
      if (idx < 0) continue;
      const newPrev = idx > 0 ? this.mounted[idx - 1].item : null;
      e.vs.update(e.item, newPrev); // re-render data + recomputed grouping on the same node
      const h = e.el.offsetHeight;   // real height after the re-render
      if (h !== e.height) { e.height = h; this.dirtyPrefix = true; }
    }
    this.measuring = false;

    // 5. FLIP every suffix entry whose absolute top changed (reorder and/or morph height delta).
    this.flipMove(suffix, oldTop);

    this.emit();
  }

  /**
   * FLIP-move (cb-move) entries whose absolute top changed in a reconcilePending pass. FLIP = First-Last-Invert-Play:
   * each mover's old top is passed in; after the reorder/height-change its new top is recomputed, an invert transform
   * makes it APPEAR still at the old top, and the @keyframes animates the transform to identity so it slides to the new.
   *
   * Rides the existing animation/animationend/`animating` convention (no CSS transition — _cb.scss uses only keyframes;
   * this keeps the animEnd test helper valid). The invert offset is a per-element CSS var (--cb-move-dy) consumed by the
   * @keyframes, set before a forced reflow so the browser registers the inverted start. `moveTimer !== undefined` is the
   * "still in flight" signal (mirrors enterTimer); cancelEntryAnim clears it on teardown. animating is bumped so balance
   * defers until the moves drain. delta===0 entries are skipped (no motion).
   */
  private flipMove(entries: Entry<T>[], oldTop: Map<Entry<T>, number>): void {
    this.flushPrefix();
    const movers: { entry: Entry<T>; el: HTMLElement; delta: number }[] = [];
    for (const e of entries) {
      if (e.leaving) continue;
      const idx = this.mounted.indexOf(e);
      if (idx < 0) continue;
      const newTop = this.topOf(idx);
      const delta = (oldTop.get(e) ?? newTop) - newTop;
      if (delta !== 0) movers.push({ entry: e, el: e.el, delta });
    }
    if (movers.length === 0) return;
    // Invert data: each mover's old→new delta as a CSS var consumed by the cb-move @keyframes `from`. Set synchronously;
    // the class is added on the NEXT frame below.
    for (const m of movers) m.el.style.setProperty('--cb-move-dy', `${m.delta}px`);
    // Play on the next requestAnimationFrame. rAF callbacks run BEFORE the next paint, so adding cb-move in the rAF
    // makes the @keyframes `from` (translateY(var) = old top) apply for the FIRST painted frame after the reorder —
    // no one-frame flash at the new layout position, and no forced synchronous reflow (the frame boundary commits the
    // invert). animating is bumped when each rAF is scheduled so balance defers during the gap frame too.
    for (const m of movers) {
      // Retire a prior in-flight cb-move on this same entry first (balance its animating bump) so the counter stays
      // exact across back-to-back flips on one element. Handles BOTH states: running (moveTimer) and rAF-pending
      // (moveRaf). Timer checked first for the same reason as cancelEntryAnim (the test rAF spy leaves a stale moveRaf
      // alongside a set moveTimer). The identity-token guard in finish() makes the prior closure no-op regardless.
      if (m.entry.moveTimer !== undefined) {
        clearTimeout(m.entry.moveTimer); m.entry.moveTimer = undefined; this.animating--;
      } else if (m.entry.moveRaf !== undefined) {
        cancelAnimationFrame(m.entry.moveRaf); m.entry.moveRaf = undefined; this.animating--;
      }
      this.animating++;
      // Identity-token guard: a finish closure acts only while it still owns the CURRENT moveTimer. A superseding
      // flipMove or cancelEntryAnim that overwrites/clears moveTimer makes this closure no-op, so `animating`
      // decrements exactly once per started animation even when two flips target the same entry.
      let myTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = (): void => {
        if (m.entry.moveTimer !== myTimer) return; // superseded or already cleared → stale, do not double-decrement
        m.entry.moveTimer = undefined;
        clearTimeout(myTimer!);
        m.el.classList.remove('cb-move');
        m.el.style.removeProperty('--cb-move-dy');
        this.onAnimEnd();
      };
      m.entry.moveRaf = requestAnimationFrame(() => {
        m.entry.moveRaf = undefined;
        if (this.destroyed) { this.onAnimEnd(); return; } // torn down mid-frame → balance animating, no DOM write
        m.el.classList.add('cb-move');
        myTimer = setTimeout(finish, ANIM_SAFETY_MS); // safety if animationend is swallowed
        m.entry.moveTimer = myTimer;
        m.el.addEventListener('animationend', finish, { once: true });
      });
    }
  }

  /** Trim the newer end (bottom, mounted last). **Keep a buffer below the viewport**: after trimming, the content
   *  bottom (totalH - h) must still be > viewport bottom (st + vh) + edge, otherwise do not trim — prevents trimming
   *  into the viewport in a way that leaves st exceeding total → a false atBottom → loadNewer jumping to the bottom.
   *  Trimming the newest end resets noNewer. No compensation (the bottom is below the viewport). */
  private trimNewer(): void {
    if (this.resorting) return; // rule 4a: never trim during a resort
    let trimmed = false;
    while (this.mounted.length > 1) {
      const last = this.mounted[this.mounted.length - 1];
      // Never trim an in-flight optimistic/transient send or an exiting (leaving) item. Rule 4c: the optimistic block
      // is atomic — reaching it aborts the trim (only reconcileOptimistic removes a member, never trim).
      if (last.transient || last.optimistic || last.leaving) break;
      this.flushPrefix();
      const h = last.height;
      if (this.totalH() - h > this.threshold && (this.totalH() - h) - (this.viewport.scrollTop + this.vh) > this.cfg.edge) {
        this.unmountBot(); trimmed = true;
      } else break;
    }
    if (trimmed) this.noNewer = false;
  }

  /** Trim the older end (top, mounted[0]). **Keep a buffer above the viewport**: after trimming, above the viewport
   *  (st - h) must be > edge (symmetric to trimNewer). Plan A **does not compensate scrollTop** (the browser's
   *  overflow-anchor pins the viewport). Trimming the oldest end resets noOlder. */
  private trimOlder(): void {
    if (this.resorting) return; // rule 4a: never trim during a resort
    let trimmed = false;
    while (this.mounted.length > 1) {
      const first = this.mounted[0];
      // Never trim transient/optimistic/leaving, and rule 4b: never trim the global-newest real item.
      if (first.transient || first.optimistic || first.leaving || first.item.boundary === 'newest' || first.item.boundary === 'both') break;
      this.flushPrefix();
      const h = first.height;
      if (this.totalH() - h > this.threshold && this.viewport.scrollTop - h > this.cfg.edge) {
        this.unmountTop(); trimmed = true;
      } else break;
    }
    if (trimmed) this.noOlder = false;
  }

  // ---------- Height reporting (no compensation) ----------

  /** Plan A: a height change does not compensate (browser anchors); only updates the cache + schedules balance. The
   *  entry reference is stable (immune to array shifts). */
  private onElHeight(entry: Entry<T>, h: number): void {
    if (this.destroyed) return;
    if (entry.height === h) return;
    entry.height = h;
    this.dirtyPrefix = true;
    if (!this.mounting && !this.measuring) this.scheduleBalance();
  }

  /** Whether an item represents the given msgId — matches CbItem.id OR any member in CbItem.ids
   *  (so a jump to a non-head album member still resolves to its album item). */
  private itemHasId(item: CbItem<T>, id: string | number): boolean {
    const key = String(id);
    if (String(item.id) === key) return true;
    const ids = item.ids;
    return ids !== undefined && ids.some(x => String(x) === key);
  }

  private indexOfId(id: string | number): number {
    return this.mounted.findIndex(e => this.itemHasId(e.item, id));
  }

  /** Index of the in-flight optimistic/transient entry carrying the given clientMessageId — the reconcile key
   *  that pairs an optimistic send with its confirmed real (the real gets a fresh server id, so the pair cannot
   *  be matched by id). Scans transient/optimistic entries only; -1 if none / cid absent. */
  private indexOfClientMsgId(cid: string | undefined): number {
    if (cid === undefined) return -1;
    return this.mounted.findIndex(e => (e.transient || e.optimistic) && e.item.clientMessageId === cid);
  }

  /** Oldest mounted item id that is a real source member — skips transient/optimistic (insertAfter inserts / in-flight
   *  pending), whose ids are not source cursors. Used by loadOlder so a transient/optimistic reaching mounted[0] after
   *  a trim does not make getOlder return [] and falsely lock noOlder. Callers guarantee mounted is non-empty. */
  private olderCursorId(): string | number {
    for (const e of this.mounted) if (!e.transient && !e.optimistic && !e.leaving) return e.item.id;
    return this.mounted[0].item.id; // unreachable in practice (the insert/remove target is always a real neighbor)
  }

  /** Newest mounted item id that is a real source member — skips transient/optimistic and leaving entries. Symmetric
   *  to olderCursorId. */
  private newerCursorId(): string | number {
    for (let i = this.mounted.length - 1; i >= 0; i--) if (!this.mounted[i].transient && !this.mounted[i].optimistic && !this.mounted[i].leaving) return this.mounted[i].item.id;
    return this.mounted[this.mounted.length - 1].item.id;
  }

  private isAtBottom(): boolean {
    return this.viewport.scrollTop + this.vh >= this.content.scrollHeight - 1;
  }

  private scrollDir(st: number): 'up' | 'down' | null {
    if (this.shifting) return null;
    if (st < this.lastScrollTop - 1) return 'up';
    if (st > this.lastScrollTop + 1) return 'down';
    return null;
  }

  private revalidateTop(): boolean {
    const st = this.viewport.scrollTop;
    return st < this.cfg.edge && this.scrollDir(st) !== 'down' && !this.noOlder;
  }

  private revalidateBottom(): boolean {
    const st = this.viewport.scrollTop;
    const total = this.totalH();
    return total - this.vh - st < this.cfg.edge && this.scrollDir(st) !== 'up' && !this.noNewer;
  }

  private absorbBoundary(items: CbItem<T>[]): void {
    for (const it of items) {
      if (it.boundary === 'oldest' || it.boundary === 'both') this.noOlder = true;
      if (it.boundary === 'newest' || it.boundary === 'both') this.noNewer = true;
    }
  }

  private measureVh(): void { this.vh = this.viewport.clientHeight; }

  private measurePending(): void {
    if (this.pendingMeasure.length === 0) return;
    const entries = this.pendingMeasure;
    this.pendingMeasure = [];
    this.measuring = true;
    let zeros = 0;
    for (const entry of entries) {
      if (this.mounted.indexOf(entry) < 0) continue; // already unmounted (guard against trim leftovers)
      const h = entry.el.offsetHeight;
      if (ngDevMode && h === 0) zeros++;
      this.onElHeight(entry, h);
      if (entry.animate) { // cb-enter kicks off on the next frame; keep cb-pending (hidden) until then so enterAnim
        // can drop it atomically with the enter class — the first painted frame is the @keyframes `from` (opacity:0),
        // never a one-frame flash at the un-hidden natural state. Non-animated mounts drop cb-pending right here.
        const cls: 'cb-enter' | 'cb-enter-above' = entry.enterAbove ? 'cb-enter-above' : 'cb-enter';
        entry.animate = false; entry.enterAbove = false;
        this.enterAnim(entry, cls);
      } else {
        entry.el.classList.remove('cb-pending');
      }
    }
    this.measuring = false;
    if (ngDevMode && (zeros > 0 || this.resetting)) console.log('[JUMP] measure n=', entries.length, 'zeroH=', zeros, 'contentScrollH=', this.content.scrollHeight);
  }

  private emit(): void { this.onScroll?.(this.getInfo()); }
}
