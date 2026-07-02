/**
 * ChatBoxScroller — array-index + source-driven virtual list (Plan B: manual scrollTop compensation).
 *
 * [array index-based] The kernel keeps an ordered `mounted: Entry[]` array (mounted[0] = oldest / DOM top → last =
 *  newest / bottom); the index is a window-local index (non-cumulative, direction-agnostic, naturally bidirectional).
 *  item.id (msgId) is only a source cursor and **takes no part in position arithmetic**. The prefix-sum `prefix[]`
 *  (flushPrefix lazy-invalidated) makes topOf/totalH O(1) amortized. Data is fetched asynchronously via {@link CbSource}
 *  (getOlder/getNewer cursors); the mergeItems hook merges albums before createItem (per-batch). Boundaries
 *  noOlder/noNewer are owned by the kernel (read from the boundary markers on items returned by the source).
 *
 * [DOM order] mounted index ascending = oldest→newest = DOM top→bottom. createEntry inserts by neighbor (index-1, the older one above).
 *
 * [Plan B compensation] Mounting upward (prepend older) + above-viewport height change → scrollTop += delta;
 *   trimming the top → scrollTop -= delta; below-viewport changes are not compensated. Hard divergence from
 *   Plan A (relies on the browser overflow-anchor, Android only).
 *
 * [Async handling] getOlder/getNewer are async; on resolve we [revalidate] (still at that edge + direction not
 *   reversed + boundary not hit), otherwise we only update the cache and do not mount (zero visual jump; the next
 *   balance mounts from cache when the user scrolls back). Compensation uses the [measured] height at resolve time,
 *   not a snapshot from request time.
 *
 * Framework-agnostic: does not import Angular. `declare ngDevMode` guards diagnostics (dead-code-eliminated in prod AOT).
 */
declare const ngDevMode: boolean | null | undefined;

import type { CbSource } from './cb-source';

export interface CbItem<T = unknown> {
  /** Real data id (the msgId from the source). Only a source cursor + read by createItem for data; **takes no part in position arithmetic** (kernel position uses the array index). */
  id: string | number;
  data: T;
  /** Boundary marker (assigned by the source): 'oldest' = global oldest, 'newest' = global newest. The kernel reads it to set noOlder/noNewer. */
  boundary?: 'oldest' | 'newest';
  /**
   * All member msgIds an aggregated item (e.g. album) represents — populated by the mergeItems hook
   * when it merges several msgs into one item (the first member equals {@link id}). Single (non-merged)
   * items leave this undefined. Purpose: id resolution for jump/positioning (scrollToIndex, indexOfId)
   * must land on the album item when the target is any album member — otherwise jumping to a non-head
   * image's msgId fails to find it (item.id only carries the head) and the viewport ends up empty
   * (jump-to-id bug). Read-only in the kernel; the source returns raw msgs and never sets this.
   */
  ids?: (string | number)[];
  /**
   * Client-generated idempotency UUID for an optimistic send — the correlation key between the in-flight
   * optimistic transient and the confirmed real the server echoes back. Present on BOTH: the optimistic item
   * (where {@link id} is also this uuid — no server msgId exists yet) and the confirmed real (where {@link id}
   * is the FRESH server msgId). The kernel reconciles the pair by THIS key, NOT by id — id-equality cannot
   * pair them, since the real carries a brand-new server id. Absent on history/incoming messages that did not
   * originate as an optimistic send. Mirrors `Message.clientMessageId` (the persisted idempotency column).
   */
  clientMessageId?: string;
}

/**
 * Handle for a mounted element. Returned by createItem; the kernel only touches the element through it.
 * onHeightChange may only be called while the element is mounted.
 *
 * There is no estimateHeight(): the kernel never guesses a height. createEntry seeds height=0 and
 * measurePending() reads the real el.offsetHeight synchronously (batched, before any positioning),
 * so the height is always the true rendered value — never an estimate that has to be corrected.
 */
export interface CbElement<T = unknown> {
  readonly el: HTMLElement;
  onHeightChange(cb: (height: number) => void): () => void;
  /** Re-render an ALREADY-mounted element in place with new data/prev (no remount). Mirrors `createItem(item, prev)`:
   *  the hook recomputes presentation (data + any prev-derived grouping/date flags) and applies it to the same DOM
   *  node + component instance. Used by reconcilePending to morph a pending send's status (sending→failed) and to
   *  re-group after a reorder, without the destroy+recreate that would break a FLIP move animation. */
  update(item: CbItem<T>, prev: CbItem<T> | null): void;
  destroy(): void;
}

/** createItem: wraps an item into a CbElement. prev = the older neighbor (index-1 within mounted), used to compute grouping (head/continuation); null if none. */
export interface CbHooks<T = unknown> {
  createItem: (item: CbItem<T>, prev: CbItem<T> | null) => CbElement<T>;
  /** Called on each source batch before createItem: presentation aggregation (e.g. merge consecutive same-creator IMAGE msgs into an album). Default noop. scope = batch (per-batch, cut across batches). */
  mergeItems?: (items: CbItem<T>[]) => CbItem<T>[];
}

/** Configurable thresholds (all optional with defaults). */
export interface CbConfig {
  /** Checkpoint trigger distance: when the viewport is within `edge` of the mounted content's top/bottom edge → enter the checkpoint. Default 1000. */
  edge?: number;
  /** Items loaded per loadOlder/loadNewer call. Default 50. */
  mountItem?: number;
  /** Window threshold floor: max(vh + vhExtra, floor). Default 6000. */
  thresholdFloor?: number;
  /** Extra pixels beyond vh (threshold = max(vh + vhExtra, thresholdFloor)). Default 2000. */
  vhExtra?: number;
  /** init first / fill batch size. Default 100. */
  initBatch?: number;
}

export interface CbOptions<T> {
  viewport: HTMLElement;
  content: HTMLElement;
  hooks: CbHooks<T>;
  source: CbSource<T>;
  config?: CbConfig;
  /** Passed through to source.init (chatId etc.). */
  initOpts?: { chatId?: number };
  onScroll?: (info: CbScrollInfo) => void;
  onDebug?: (stats: CbDebugStats) => void;
}

export interface CbScrollInfo {
  scrollTop: number;
  scrollHeight: number;
  viewportHeight: number;
  /** Mounted window boundary item.id (msgId). */
  oldestId: string | number | null;
  newestId: string | number | null;
  mounted: number;
  atTop: boolean;
  atBottom: boolean;
  noOlder: boolean;
  noNewer: boolean;
}

/** Per-frame balance diagnostics (onDebug payload, debug UI only). */
export interface CbDebugStats {
  ms: number;
  mount: number;
  unmount: number;
  scrollTop: number;
  oldestId: string | number | null;
  newestId: string | number | null;
  inflightOlder: boolean;
  inflightNewer: boolean;
}

/** init() options: jump / re-anchor (open at a specific message). */
export interface CbInitOpts {
  /** Fetch bidirectionally with this msgId as the anchor (default none = first screen from global newest). */
  startMsgId?: string | number | null;
  /** How the target aligns in the viewport (default 'center'). */
  anchor?: 'top' | 'center' | 'bottom';
  /** Add a one-shot highlight flash to the target after positioning (default false). */
  highlight?: boolean;
}

/** Public kernel capabilities (satisfied by both Plan A/B). */
export interface ScrollerApi<T = unknown> {
  /** First-screen load; if opts.startMsgId is given, open at that message (re-anchor), otherwise lay out from the global newest. */
  init(opts?: CbInitOpts): Promise<void>;
  scrollToBottom(): void;
  scrollToTop(): void;
  /** Jump to id: if mounted, position directly; if not, reset the window around the id (re-seed) then position. anchor defaults to 'center'. highlight adds a one-shot flash to the target. */
  scrollToIndex(id: string | number, anchor?: 'top' | 'center' | 'bottom', highlight?: boolean): void;
  /** Insert a single item immediately after the mounted entry representing afterId. No-op (returns false) if afterId
   *  is not currently mounted or a re-seed is in progress. Does NOT trigger balance (no checkpoint load, no trim) —
   *  Plan B only compensates scrollTop for any growth above the viewport so the viewport stays put; Plan A relies on
   *  overflow-anchor. By default the inserted item is transient (viewport-only, not registered with the source: a
   *  debug FAKE insert). Pass {optimistic:true} for a pending send — the entry is marked optimistic (in source.pending,
   *  returned by getNewer; skipped by cursors; protected from trim as part of the atomic optimistic block). */
  insertAfter(afterId: string | number, item: CbItem<T>, opts?: { optimistic?: boolean }): boolean;
  /** Remove mounted entries by id — accepts one id or an array. A fake-id, pending-id, real-id, or any album-member id
   *  all resolve to the same mounted entry (album-aware). Each removed entry plays a cb-leave exit animation; the logical
   *  unmount is deferred to animationend. Returns the count of entries scheduled for removal (0 = none mounted). */
  removeItem(ids: string | number | (string | number)[]): number;
  /** Direct-mount path for live items (incoming messages). Caches via source.pushLive, then mounts the items at the
   *  tail (dedup by id; follows to the bottom if pinned). Production WS and the playground's incoming-reply path use
   *  this. NOT the optimistic-confirm path — that goes through {@link onMessageSignal} (which pulls via getNewer and
   *  runs reconcileOptimistic). */
  appendLive(items: CbItem<T>[]): void;
  /** Signal that new messages are available (source already cached them via pushLive). If the kernel still mounts the
   *  global newest, pulls the new items via loadNewer (getNewer), runs reconcileOptimistic (remove any optimistic sends
   *  whose real counterpart arrived, tagging the real cb-confirmed), follows to the bottom if pinned, and trims. If the
   *  newer end is trimmed, this is a no-op (the items are cached; loaded on scroll-back). */
  onMessageSignal(): Promise<void>;
  /** Re-sync the mounted optimistic/pending entries to the source's current `getPending()` snapshot — the entry point
   *  the caller uses after mutating the pending store (e.g. marking a send failed and sinking it to the end). For each
   *  mounted optimistic entry: morphs its data in place via `CbElement.update` (no remount) when the status changed,
   *  reorders the optimistic tail block to match the source order, and FLIP-animates (cb-move) every entry whose
   *  absolute top changed. No I/O (pure re-read of getPending). No-op when no optimistic entries are mounted. */
  reconcilePending(): Promise<void>;
  getInfo(): CbScrollInfo;
  refresh(): void;
  destroy(): void;
}

const DEFAULTS: Required<CbConfig> = {
  edge: 1000, mountItem: 50, thresholdFloor: 6000, vhExtra: 2000, initBatch: 100,
};

/** Mounted entry: item (with msgId) + element handle + cached height + height unsubscribe. Fields are mutable (rebuild replaces el/vs/height/unsub). */
interface Entry<T> {
  item: CbItem<T>;
  el: HTMLElement;
  vs: CbElement<T>;
  height: number;
  unsub: () => void;
  /** True for items inserted via insertAfter (not registered with the source). Such ids are invalid getOlder/getNewer
   *  cursors, so cursor derivation (olderCursorId/newerCursorId) skips them — prevents a transient at either end from
   *  making a load return [] and falsely locking noOlder/noNewer. */
  transient: boolean;
  /** True for an in-flight pending send (insertAfter {optimistic:true}): registered with source.pending, returned by
   *  getNewer when the real batch is short. Skipped by cursor derivation (its id is not in the reloadable sequence)
   *  and protected from trim — the optimistic block at the tail is atomic (all loaded by once, removed by once; only
   *  reconcileOptimistic removes a member, never trim). Mutually exclusive with `transient` (FAKE inserts). */
  optimistic: boolean;
  /** True for a just-mounted real item that confirms an optimistic send — mounted visibly at its true position and
   *  flagged so reconcileOptimistic removes the matching optimistic duplicate and tags this real cb-confirmed (gating the
   *  sent-check choreography). No hiding: the swap runs synchronously within the loadNewer→reconcile microtask, so the
   *  two-bubble state is never painted. Set by the loadNewer mount-dispatch; cleared at reconcile. */
  resortTarget: boolean;
  /** Set true on a mount that should play the cb-enter animation (insertAfter + appendLive only; scroll-loaded
   *  history batches never animate). Consumed once by measurePending (after cb-pending is dropped) which calls
   *  enterAnim and clears the flag. */
  animate: boolean;
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
}

export class ChatBoxScroller<T = unknown> implements ScrollerApi<T> {
  private readonly viewport: HTMLElement;
  private readonly content: HTMLElement;
  private readonly hooks: CbHooks<T>;
  private readonly source: CbSource<T>;
  private readonly cfg: Required<CbConfig>;
  private readonly initOpts: { chatId?: number };
  private readonly onScroll?: (info: CbScrollInfo) => void;
  private readonly onDebug?: (stats: CbDebugStats) => void;

  /** Ordered mounted entries: index 0 = oldest (DOM top) → last = newest (DOM bottom). The index is a window-local index. */
  private mounted: Entry<T>[] = [];
  /** Prefix sum: prefix[i] = Σheight[0..i-1] (prefix[0] = 0, prefix[n] = totalH). Recomputed by flushPrefix when dirtyPrefix. */
  private prefix: number[] = [0];
  private dirtyPrefix = true;

  private noOlder = false;
  private noNewer = false;
  /** The entry currently showing the skeleton (= mounted[0] when !noOlder); null = no skeleton. Compared by entry reference (immune to array shifts). */
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
  /** Reset generation: incremented by openAround; compared after the await in loadOlder/loadNewer so stale batches are not mounted (guards against a jump overtaking an in-flight load). */
  private gen = 0;
  /** Re-seed in progress (between resetWindowState and mount): appendLive drops WS during this (already in the source cache, retrieved by getNewer when scrolling back). */
  private resetting = false;
  /** Debug switch: turn off the mount checkpoint (balance will not trigger loadOlder/loadNewer). Guarded by ngDevMode inside balance → removed in prod AOT. Default false (checkpoint loads normally). */
  closeCheckpoint = false;

  /** Queue of entries awaiting real-height measurement (stores entry refs; the callback reads the current index via indexOf). */
  private pendingMeasure: Entry<T>[] = [];

  private vh = 0;
  private shifting = false;   // suppresses scroll-direction misdetection + onElHeight compensation caused by programmatic scrollTop writes
  /** Set after a viewport-resize reflow re-pins to bottom. The programmatic pinToBottom write fires an async scroll
   *  event (after `shifting` has already reset synchronously); onNativeScroll consumes this flag once so that scroll
   *  event does not re-arm balance and load/trim at the bottom edge during a viewport shrink (e.g. the soft keyboard
   *  opening/closing). ResizeObserver only fires on a real size change, so the pin's scrollTop write always changes
   *  value → always fires exactly one scroll event → the flag is always consumed. */
  private suppressScrollBalance = false;
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
  /** Set during reconcileOptimistic. Reconcile is synchronous (no slide animation) and never spans an await, so this is
   *  never observed true by a deferred trim — kept so trimOlder/trimNewer (rule 4a) stay self-documenting. */
  private resorting = false;
  private readonly viewportObs: ResizeObserver;

  constructor(opts: CbOptions<T>) {
    this.viewport = opts.viewport;
    this.content = opts.content;
    this.hooks = opts.hooks;
    this.source = opts.source;
    this.onScroll = opts.onScroll;
    this.onDebug = opts.onDebug;
    this.initOpts = opts.initOpts ?? {};
    this.cfg = { ...DEFAULTS, ...opts.config };
    this.viewportObs = new ResizeObserver(() => this.onViewportResize());
    this.measureVh();
    this.viewportObs.observe(this.viewport);
    this.viewport.addEventListener('scroll', this.onNativeScroll, { passive: true });
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
    if (merged.length === 0) return;
    this.absorbBoundary(merged);
    this.mountBatch(merged, 'init');
    while (this.totalH() < this.threshold && !this.noOlder && this.mounted.length > 0) {
      const cursor = this.mounted[0].item.id; // oldest mounted msgId
      batch = await this.source.getOlder(cursor, this.cfg.initBatch);
      merged = this.mergeBatch(batch);
      if (merged.length === 0) { this.noOlder = true; break; }
      this.absorbBoundary(merged);
      this.mountBatch(merged, 'older'); // no internal measure
      this.measurePending();            // unified measure for fill batches (init pins to bottom, compensation is irrelevant)
    }
    this.scrollToBottom();
    this.updateGhost();
  }

  appendLive(rawItems: CbItem<T>[]): void {
    if (this.destroyed || rawItems.length === 0) return;
    // Direct-mount path for live items (production WS incoming). Cache via pushLive, then mount at the tail. This path
    // does NOT reconcile optimistic sends — production has none, and the playground routes its live messages (incoming +
    // optimistic confirm) through onMessageSignal, which inserts reals at their true position and reconciles. Dedup by id
    // (an incoming that raced with a load is already mounted → skip).
    this.source.pushLive(rawItems);
    if (this.resetting) { this.emit(); return; }            // re-seed in progress: cached; mount on scroll-back
    const remaining = rawItems.filter(it => this.indexOfId(it.id) < 0);
    if (remaining.length === 0) { this.emit(); return; }
    if (!this.noNewer) { this.emit(); return; }              // newer end trimmed → cache only (load on scroll-back)
    const wasAtBottom = this.isAtBottom();
    const merged = this.mergeBatch(remaining);
    this.mountBatch(merged, 'newer', true);                  // animate=true: a live message arriving is a "new message appears" event
    this.noNewer = true;                                     // live items are the global newest
    if (wasAtBottom) this.scrollToBottom();                  // at global newest → pin to reveal the new message
    this.emit();
  }

  /** Signal that new messages are available (the source already cached them via pushLive). If the kernel still mounts
   *  the global newest, pull the new items via loadNewer (getNewer returns cached reals), run reconcileOptimistic (remove
   *  any optimistic sends whose real counterpart arrived, tagging the real cb-confirmed), trim the older edge + sync
   *  ghost/cap, THEN follow to the bottom if pinned. Trimming before the pin is essential: trim mutates content (drops
   *  top items → scrollHeight shrinks), so the pin must anchor to the post-trim bottom — pinning before trim left the
   *  latest message below the fold (pinToBottom reads live scrollHeight, so it is immune to cached-height drift). If the
   *  newer end is trimmed, this is a no-op (items are cached; loaded on scroll-back). */
  async onMessageSignal(): Promise<void> {
    if (this.destroyed || this.resetting) return;
    if (!this.noNewer) return;                               // newer end trimmed → cached only; load on scroll-back
    const wasAtBottom = this.isAtBottom();
    await this.loadNewer(true);                              // forced: the signal means new data is available (bypasses the noNewer/revalidate guards)
    if (this.destroyed) return;
    await this.reconcileOptimistic();                       // remove optimistic duplicates (synchronous) so the bottom is final
    if (this.destroyed) return;
    // Trim + ghost + cap BEFORE the pin: these mutate content (remove top items → scrollHeight shrinks), so pinning to the
    // FINAL bottom must come after them. Pinning before trim anchored scrollTop to a pre-trim bottom and the subsequent trim
    // shifted it off (the latest message dropped below the fold on the first send). pinToBottom reads live scrollHeight, so
    // it is immune to the cached-height drift that trimOlder's scrollTop compensation is subject to.
    this.trimOlder();
    this.updateGhost();
    this.updateTailCap();
    if (wasAtBottom) this.pinToBottom();                     // follow to the FINAL bottom (after reconcile + trim): the removed optimistic duplicate and the trimmed top are already accounted for
    this.emit();
  }

  /**
   * Insert one item immediately after the mounted entry representing afterId. No-op (returns false) if afterId is not
   * currently mounted (the request is neglected) or a re-seed is in progress.
   *
   * **No balance**: never triggers loadOlder/loadNewer/trim. measurePending runs under its `measuring` guard so the
   *  height settle does not schedule balance (unlike mountBatch). The only side effect on the viewport is scroll-height
   * compensation: any growth above the viewport pushes content down → scrollTop += delta, so the viewport stays pinned.
   *
   * The successor (the entry that was at idx+1) has its prev changed (target → new item), so it is rebuilt in place
   * for group-head/date to recompute (same lightweight rebuildEntry as the ghost reveal). Entries further down keep the
   * same prev item and need no rebuild. The new entry is marked transient (not a source cursor).
   */
  insertAfter(afterId: string | number, item: CbItem<T>, opts?: { optimistic?: boolean }): boolean {
    if (this.destroyed || this.resetting) return false;
    const idx = this.indexOfId(afterId);
    if (idx < 0) return false;                  // not mounted → neglect the insert request
    const st = this.viewport.scrollTop;          // capture BEFORE any compensation (both checks use the original fold)
    const target = this.mounted[idx];
    const successor = this.mounted[idx + 1] ?? null;
    const oldSuccH = successor ? successor.height : 0;
    const anchorEl = successor ? successor.el : null;

    // New entry: prev = target item (older neighbor). DOM lands between target and successor (createEntry inserts
    // before anchorEl; no successor → append). cb-pending hides it until measurePending settles the real height;
    // animate=true so it plays cb-enter once measured (a viewport-level insert is a "new message appears" event).
    const entry = this.createEntry(item, target.item, anchorEl, true);
    if (opts?.optimistic) entry.optimistic = true;   // pending send: in source.pending, returned by getNewer, atomic
    else entry.transient = true;                      // FAKE debug insert: viewport-only, never in the source
    this.mounted.splice(idx + 1, 0, entry);
    if (successor) this.rebuildEntry(successor); // prev changed → recompute group-head/date (height reset, re-measured below)

    this.dirtyPrefix = true;
    this.measurePending();                       // `measuring` suppresses onElHeight compensate/balance → unified below

    // Plan B compensation: a height delta Δ at content position P pushes the fold down iff P is above the viewport
    // (P < scrollTop). The new item is one such Δ (newH at topOf(idx+1)); the successor rebuild is another (d at
    // topOf(idx+2)). Independent and additive. Within/below-viewport inserts need no shift (the fold content is unchanged).
    const newH = entry.height;
    if (this.topOf(idx + 1) < st) this.compensateAbove(newH);
    if (successor) {
      const d = successor.height - oldSuccH;
      if (d !== 0 && this.topOf(idx + 2) < st) this.compensateAbove(d);
    }
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
      const idx = this.indexOfId(id);                 // album-aware (itemHasId → whole album item)
      if (idx < 0) continue;
      const e = this.mounted[idx];
      if (!e.leaving && !targets.includes(e)) targets.push(e); // dedup (several album ids → same entry)
    }
    for (const e of targets) this.leaveEntry(e);      // each starts its own concurrent cb-leave
    if (targets.length > 0) this.emit();
    return targets.length;
  }

  /** Start one entry's cb-leave exit: mark leaving, animating++, add the class; complete the unmount on animationend
   *  (or the safety timeout). On completion Plan B compensates scrollTop if the row was above the viewport. */
  private leaveEntry(entry: Entry<T>): void {
    entry.leaving = true;
    entry.leaveDone = false;
    this.animating++;
    entry.el.classList.add('cb-leave');
    const onEnd = (): void => {
      if (entry.leaveDone) return;
      entry.leaveDone = true;
      if (entry.leaveTimer !== undefined) { clearTimeout(entry.leaveTimer); entry.leaveTimer = undefined; }
      entry.el.classList.remove('cb-leave');
      const i = this.mounted.indexOf(entry);          // re-find (concurrent removes shift indices)
      if (i >= 0) {
        // Plan B: keep the viewport pinned if the removed row sat above the fold (content below shifts up by its height).
        if (this.topOf(i) < this.viewport.scrollTop) this.compensateAbove(-entry.height);
        this.unmountAt(i);
      }
      entry.leaving = false;
      this.onAnimEnd();                               // drains animating; fires the deferred balance
    };
    entry.el.addEventListener('animationend', onEnd, { once: true });
    entry.leaveTimer = setTimeout(onEnd, 600);        // safety if animationend is swallowed
  }

  scrollToBottom(): void {
    if (this.destroyed) return;
    this.pinToBottom();
    // Newest end trimmed (window moved back, noNewer=false) → load back to the global newest. The follow chain is
    // explicit go-to-bottom intent (followToNewest); balance-triggered loadNewer never follows, so scrolling to the
    // bottom edge only loads one batch and leaves the viewport put (symmetric to loadOlder).
    if (!this.noNewer) void this.followToNewest();
  }

  /** Position the viewport at the content bottom (instant, compensation-safe via `shifting`) and emit. */
  private pinToBottom(): void {
    this.shifting = true;
    this.viewport.scrollTop = this.content.scrollHeight - this.vh;
    this.shifting = false;
    this.lastScrollTop = this.viewport.scrollTop;
    this.emit();
  }

  /**
   * Explicit go-to-bottom follow (started by scrollToBottom): keep loading one newer batch and re-pinning to the
   * bottom until the global newest (noNewer). balance-triggered loadNewer does NOT come through here, so a user
   * scrolling to the bottom edge never chain-jumps to the newest. gen guard bails if a jump overtakes mid-chain.
   */
  private async followToNewest(): Promise<void> {
    const g = this.gen;
    while (!this.noNewer && !this.destroyed && this.mounted.length > 0) {
      const n = await this.loadNewer();              // pure core: one batch, mount + trim, NO follow
      if (this.destroyed || g !== this.gen) return;  // jump re-seed overtook
      if (n === 0) break;                            // boundary / no data
      this.pinToBottom();                            // follow to the new bottom; loop continues while !noNewer
    }
  }

  scrollToTop(): void {
    if (this.destroyed) return;
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
    if (idx >= 0) { // mounted: position directly
      this.positionMounted(idx, anchor);
      if (highlight) this.flashHighlight(idx);
      return;
    }
    // Not mounted: reset the window around the id (re-seed), then position once done
    void this.openAround(id, anchor, highlight);
  }

  /**
   * Reset the window around id: unmount the current window → source.init(id, older, newer) fetches one bidirectional
   * batch → mount → [position onto id immediately] → fillAround fills both ways (re-pin per batch) → final positioning.
   * Immediate positioning + per-batch re-pin: keeps the target pinned to its anchor across the first paint and the
   * entire async fill, avoiding the "show the window top, then scroll into place" jump.
   * Incrementing gen invalidates in-flight loadOlder/loadNewer; appendLive is dropped while resetting (WS messages are
   * in the source cache, retrieved by getNewer when scrolling back). A centered anchor needs enough content on both
   * sides for a "true center"; fillAround grows the window to threshold (best-effort near boundaries, clamp concedes).
   */
  private async openAround(id: string | number, anchor: 'top' | 'center' | 'bottom', highlight: boolean): Promise<void> {
    const g = ++this.gen;
    if (ngDevMode) console.log('[JUMP] openAround start id=', id, 'gen=', g, 'vh=', this.vh, 'threshold=', this.threshold);
    this.resetWindowState();
    try {
      const batch = await this.source.init(id, this.cfg.mountItem, this.cfg.mountItem, this.initOpts);
      if (this.destroyed || g !== this.gen) { if (ngDevMode) console.log('[JUMP] bail: gen overtaken / destroyed'); return; } // overtaken by a newer jump / destroyed
      const merged = this.mergeBatch(batch);
      const key = String(id);
      const hasTarget = merged.some(it => this.itemHasId(it, id));
      if (ngDevMode) console.log('[JUMP] init batch merged=', merged.length, 'hasTarget=', hasTarget, 'ids=', merged.slice(0, 2).map(i => i.id), '..', merged.slice(-2).map(i => i.id), 'noOlder/noNewer=', this.noOlder, this.noNewer);
      if (merged.length === 0 || !hasTarget) { this.updateGhost(); this.emit(); return; } // source did not return the target
      this.absorbBoundary(merged);
      this.mountBatch(merged, 'init');
      this.measurePending();
      if (ngDevMode) console.log('[JUMP] after init mount+measure: mounted=', this.mounted.length, 'totalH=', Math.round(this.totalH()), 'sampleH=', this.mounted.slice(0, 5).map(e => Math.round(e.height)));
      // Pin the target to its anchor BEFORE the first async fill await yields to the painter.
      // resetWindowState left scrollTop=0; without this early pin the init batch paints at the window
      // top and the target only "arrives" via a visible scroll at the end (show-then-scroll glitch).
      // fillAround re-pins after every load so the target holds its anchor across the whole fill.
      {
        const initIdx = this.indexOfId(id);
        if (initIdx >= 0) this.positionMounted(initIdx, anchor);
      }
      await this.fillAround(id, anchor, g); // fill both ways to threshold/2 each (boundary exceptions) + when one side hits a boundary fill the other to threshold; re-pin after each batch
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
   *  1) Fill upward until aboveTarget ≥ threshold/2 (or hit noOlder); fill downward until belowTarget ≥ threshold/2 (or hit noNewer).
   *  2) Compensate: if one side hit a boundary (< threshold/2) → fill the other (still-open) side until totalH ≥ threshold
   *     (if both hit boundaries there is nothing to fill — just render).
   * The viewport is already pinned to the target (openAround positioned it before the first await), and `pin()` re-pins
   * after every load — upward prepends add height above the target and would otherwise drift it down/out of view while
   * the next batch's async fetch yields to the painter. fill still neither trims nor live-compensates (unlike
   * loadOlder/loadNewer); re-positioning from the current prefix is the single source of truth for the anchor.
   * gen guard drops batches overtaken by a newer jump. Iteration counts are surfaced once in the fill-done log — a spike
   * (e.g. up=200) would reveal a heights-read-as-0 regression without per-iteration spam.
   */
  private async fillAround(targetId: string | number, anchor: 'top' | 'center' | 'bottom', g: number): Promise<void> {
    const halfTh = this.threshold / 2;
    /** Re-anchor the target after a fill mutation (prefix changed). No-op clamp aside, keeps the target on its anchor. */
    const pin = (): void => { const i = this.indexOfId(targetId); if (i >= 0) this.positionMounted(i, anchor); };
    let upIter = 0;
    while (this.aboveTarget(targetId) < halfTh && !this.noOlder && this.mounted.length > 0) {
      const n = await this.loadOlderIntoFresh(g);
      upIter++;
      if (n === 0) break; // reached boundary / overtaken / no data
      pin(); // prepend drifted target down → re-center before the next fetch yields to the painter
    }
    let downIter = 0;
    while (this.belowTarget(targetId) < halfTh && !this.noNewer && this.mounted.length > 0) {
      const n = await this.loadNewerIntoFresh(g);
      downIter++;
      if (n === 0) break;
      pin(); // append below doesn't move the target, but keeps the clamp/max honest near edges
    }
    let compIter = 0;
    if (this.totalH() < this.threshold) {
      const fillUp = this.noNewer && !this.noOlder;   // bottom reached → fill upward
      const fillDown = this.noOlder && !this.noNewer; // top reached → fill downward
      while (this.totalH() < this.threshold && (fillUp || fillDown) && this.mounted.length > 0) {
        const n = fillUp ? await this.loadOlderIntoFresh(g) : await this.loadNewerIntoFresh(g);
        compIter++;
        if (n === 0) break; // other side also reached boundary
        pin();
      }
    }
    if (ngDevMode) console.log('[JUMP] fill iters up/down/comp=', upIter, downIter, compIter, 'totalH=', Math.round(this.totalH()));
  }

  /** Total height of all mounted entries above targetId (= topOf(targetIdx)). If the target is not in the window, treat everything as above. */
  private aboveTarget(targetId: string | number): number {
    const idx = this.indexOfId(targetId);
    return idx < 0 ? this.totalH() : this.topOf(idx);
  }
  /** Total height of all mounted entries below targetId (excluding the target itself). If the target is not in the window → 0. */
  private belowTarget(targetId: string | number): number {
    const idx = this.indexOfId(targetId);
    if (idx < 0) return 0;
    this.flushPrefix();
    return this.totalH() - this.prefix[idx + 1];
  }

  /** Load one older batch into the building window (no compensation / no trim / no revalidate — viewport not positioned yet); includes the old ghost reveal rebuild. Empty batch → noOlder. Returns the number mounted (0 = hit boundary / overtaken / no data). */
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
  /** Load one newer batch into the building window (append). Empty batch → noNewer. Returns the number mounted (0 = hit boundary / overtaken / no data). */
  private async loadNewerIntoFresh(g: number): Promise<number> {
    if (this.destroyed || g !== this.gen || this.noNewer || this.mounted.length === 0) return 0;
    const cursor = this.newerCursorId();
    const batch = await this.source.getNewer(cursor, this.cfg.mountItem);
    if (this.destroyed || g !== this.gen) return 0;
    const merged = this.mergeBatch(batch);
    if (merged.length === 0) { this.noNewer = true; return 0; }
    this.absorbBoundary(merged);
    this.mountBatch(merged, 'newer');
    this.measurePending();
    this.updateGhost();
    return merged.length;
  }

  /** Positioning math for a mounted idx (shared by scrollToIndex / openAround). `shifting` suppresses direction misdetection. */
  private positionMounted(idx: number, anchor: 'top' | 'center' | 'bottom'): void {
    this.flushPrefix();
    let st = this.prefix[idx];
    const h = this.mounted[idx].height;
    if (anchor === 'center') st += h / 2 - this.vh / 2;
    else if (anchor === 'bottom') st += h - this.vh;
    const max = this.content.scrollHeight - this.vh;
    this.shifting = true;
    this.viewport.scrollTop = Math.max(0, Math.min(st, max));
    this.shifting = false;
    this.lastScrollTop = this.viewport.scrollTop;
    if (ngDevMode) console.log('[JUMP] positionMounted idx=', idx, 'id=', this.mounted[idx]?.item.id, 'topOf=', Math.round(this.prefix[idx]), 'h=', Math.round(h), 'rawSt=', Math.round(st), 'max=', Math.round(max), 'vh=', this.vh, '-> scrollTop=', Math.round(this.viewport.scrollTop));
    this.emit();
  }

  /** Clear the window + reset all load/boundary state (called at the start of openAround). unmountAll already cleared mounted/prefix/pending/ghost. */
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

  /** Add a one-shot highlight flash to the target entry (animationend removes the class; a reflow guarantees the animation restarts on repeated jumps). */
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

  destroy(): void {
    this.destroyed = true;
    cancelAnimationFrame(this.rafId);
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

  // ---------- Mounting (array index; DOM follows mounted order) ----------

  /** mergeItems hook (default noop). Called once per source batch, before createItem. scope = batch. */
  private mergeBatch(batch: CbItem<T>[]): CbItem<T>[] {
    return this.hooks.mergeItems ? this.hooks.mergeItems(batch) : batch;
  }

  /**
   * Mount one batch (already merged): side = init/older → prepend (front of mounted, DOM inserted before the old head); newer → append (end).
   * older does not measure internally (loadOlder does the unified measure + ghost rebuild); init/newer measure at the end.
   * prev = the older neighbor: the previous one within the batch (ascending), or the old tail on append.
   */
  private mountBatch(merged: CbItem<T>[], side: 'init' | 'older' | 'newer', animate = false): void {
    if (merged.length === 0) return;
    if (side === 'newer') {
      for (let i = 0; i < merged.length; i++) {
        const prev = i > 0 ? merged[i - 1] : (this.mounted.length > 0 ? this.mounted[this.mounted.length - 1].item : null);
        this.mounted.push(this.createEntry(merged[i], prev, undefined, animate));
      }
    } else { // init / older both prepend (when init, mounted is empty, anchorEl = null → appendChild)
      const anchorEl = this.mounted.length > 0 ? this.mounted[0].el : null;
      const fresh: Entry<T>[] = [];
      for (let i = 0; i < merged.length; i++) {
        const prev = i > 0 ? merged[i - 1] : null;
        fresh.push(this.createEntry(merged[i], prev, anchorEl)); // never animate prepended history
      }
      this.mounted.unshift(...fresh);
    }
    this.dirtyPrefix = true;
    if (side !== 'older') this.measurePending();
    this.updateTailCap(); // re-measure the cap every batch mount: a newer batch reaching the global newest flips loading→gap
  }

  /** Create and mount one entry: createItem + DOM insert (before anchorEl / append) + pendingMeasure + subscribe to height.
   *  `animate` (default false) marks a mount that should play cb-enter after its height settles — only insertAfter and
   *  appendLive pass true; scroll-loaded history batches (init/older/newer) never animate. */
  private createEntry(item: CbItem<T>, prev: CbItem<T> | null, anchorEl?: HTMLElement | null, animate = false): Entry<T> {
    if (ngDevMode) this.mountTick++;
    const vs = this.hooks.createItem(item, prev);
    const el = vs.el;
    el.dataset['cbId'] = String(item.id);
    if (anchorEl !== undefined && anchorEl !== null) this.content.insertBefore(el, anchorEl);
    else if (this.tailCapEl) this.content.insertBefore(el, this.tailCapEl); // append path: keep the tail cap always last
    else this.content.appendChild(el);
    const entry: Entry<T> = { item, el, vs, height: 0, unsub: () => {}, transient: false, optimistic: false, resortTarget: false, animate, leaving: false, leaveDone: false }; // real height set by measurePending()
    el.classList.add('cb-pending');
    this.pendingMeasure.push(entry);
    this.mounting = true; // suppress the first report (same as id-based)
    entry.unsub = vs.onHeightChange(h => this.onElHeight(entry, h));
    this.mounting = false;
    return entry;
  }

  /**
   * Rebuild a mounted entry in place: re-runs createItem with the current real prev (mounted[idx-1], the older neighbor),
   * replaces the DOM in place, and migrates the subscription.
   * **Lightweight**: does not measurePending — loadOlder does one unified measure after "mount new batch + ghost reveal".
   * Use case: skeleton reveal (the old mounted[0] shifts down after a prepend, prev changes from null to non-null, so
   * group-head / date must be recomputed).
   */
  /**
   * Rebuild a mounted entry in place: re-runs createItem with the current real prev (mounted[idx-1], the older neighbor),
   * replaces the DOM in place, and migrates the subscription. When `newItem` is given (settle: optimistic→confirmed), the
   * entry's item is replaced too; otherwise (ghost reveal) the item is unchanged.
   * **Lightweight**: does not measurePending — loadOlder does one unified measure after "mount new batch + ghost reveal".
   * Use cases: skeleton reveal (the old mounted[0] shifts down after a prepend, prev changes from null to non-null, so
   * group-head / date must be recomputed); settle (appendLive confirmed an optimistic transient → re-render real data).
   * Never sets `animate` (a rebuild reuses an already-visible slot; no cb-enter).
   */
  private rebuildEntry(entry: Entry<T>, newItem: CbItem<T> = entry.item): void {
    const idx = this.mounted.indexOf(entry);
    if (idx < 0) return;
    if (ngDevMode) this.mountTick++;
    const newPrev = idx > 0 ? this.mounted[idx - 1].item : null; // older neighbor (one index lower)
    const newVs = this.hooks.createItem(newItem, newPrev);
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

  /** Unmount the oldest (mounted[0], DOM top). Does not compensate scrollTop (the caller trimOlder compensates inside `shifting`). */
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

  /** Unmount the entry at an arbitrary index (used by removeItem's exit-animation completion). No scrollTop compensation
   *  here — the caller (leaveEntry) compensates if the row was above the fold. */
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
   *  Decrements `animating` exactly once per in-flight animation (guarded by enterTimer / leaveDone / moveTimer) so the
   *  counter does not leak across a window reset, and the deferred animationend/timeout handlers become no-ops. */
  private cancelEntryAnim(entry: Entry<T>): void {
    if (entry.enterTimer !== undefined) {
      clearTimeout(entry.enterTimer); entry.enterTimer = undefined;
      entry.el.classList.remove('cb-enter');
      this.animating--;
    }
    if (entry.leaving && !entry.leaveDone) {
      if (entry.leaveTimer !== undefined) clearTimeout(entry.leaveTimer);
      entry.leaveDone = true; entry.el.classList.remove('cb-leave');
      this.animating--;
    }
    if (entry.moveTimer !== undefined) {
      clearTimeout(entry.moveTimer); entry.moveTimer = undefined;
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

  /** Sync skeleton state (pure class): skeleton = mounted[0] (oldest mounted) when "not yet at the global oldest". Compared by entry reference. */
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
   * global newest flips loading→gap and genuinely changes the height) and on resize via tailCapObs. No scrollTop
   * compensation: the cap sits below every real item, so a height change moves nothing above it; when visible we are
   * already re-pinned by pinToBottom/followToNewest.
   */
  private updateTailCap(): void {
    const el = this.tailCapEl;
    if (!el) return;
    const mode: 'hidden' | 'gap' | 'loading' = this.mounted.length === 0 ? 'hidden' : this.noNewer ? 'gap' : 'loading';
    el.classList.toggle('cb-tail-cap--gap', mode === 'gap');
    el.classList.toggle('cb-tail-cap--loading', mode === 'loading');
    this.tailCapH = el.offsetHeight;
  }

  // ---------- balance: checkpoint + loading ----------

  /** Viewport resized (soft keyboard open/close, orientation change, window resize). This is a *reflow*, not a
   *  checkpoint: re-measure vh and keep the reading position.
   *  - Was pinned to bottom: stay pinned (the bottom moved with the new vh) and do NOT load/trim — the transient
   *    balance a shrink triggers is the visible jitter, and a re-pin is the only correct response.
   *  - Mid-screen: scrollTop is unchanged in absolute px so the same line stays in view; scheduleBalance is a no-op
   *    unless the user happens to sit at an edge.
   *  Content-driven rebalances (item height changes, native scroll) still run via onElHeight + onNativeScroll. */
  private onViewportResize(): void {
    if (this.destroyed) return;
    const wasAtBottom = this.isAtBottom();   // capture BEFORE re-measure (uses the old vh)
    this.measureVh();                         // apply the new vh
    if (wasAtBottom && this.mounted.length > 0) {
      this.pinToBottom();
      // pinToBottom writes scrollTop under the shifting guard, but that guard resets synchronously — before the async
      // scroll event is dispatched. Set the one-shot flag so onNativeScroll swallows that event (no load/trim at bottom).
      this.suppressScrollBalance = true;
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

  /** Play the cb-enter mount animation on a freshly-measured entry (cb-pending already removed → visible).
   *  `enterTimer !== undefined` is the "still in flight" signal; finish() and teardown both guard on it so the
   *  `animating` counter is decremented exactly once (animationend, safety timeout, or forced unmount). */
  private enterAnim(entry: Entry<T>): void {
    const finish = () => {
      if (entry.enterTimer === undefined) return;
      clearTimeout(entry.enterTimer); entry.enterTimer = undefined;
      entry.el.classList.remove('cb-enter');
      this.onAnimEnd();
    };
    entry.el.classList.add('cb-enter');
    this.animating++;
    entry.enterTimer = setTimeout(finish, 600); // safety if animationend is swallowed
    entry.el.addEventListener('animationend', finish, { once: true });
  }

  /** balance: the scroll-driven checkpoint. Loads one batch at the edge that triggered (older at top / newer at bottom),
   *  then trims the **opposite** end (split: trim is a separate phase, invoked by the caller after the load resolves).
   *  Async because it awaits the load (+ reconcileOptimistic on the newer edge) before trimming; the RAF caller ignores
   *  the returned promise, and `animating>0` / inflight guards prevent harmful re-entry. */
  private async balance(): Promise<void> {
    if (this.destroyed || this.mounted.length === 0) return;
    if (ngDevMode && this.closeCheckpoint) return; // debug: turn off the mount checkpoint (do not trigger loadOlder/loadNewer; removed in prod AOT)
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
   * Load older: getOlder (cursor = olderCursorId(), the oldest non-transient/optimistic mounted item) + mergeItems +
   * prepend mount + old-ghost reveal rebuild. **Pure load — no trim** (split: the caller — balance — trims the opposite
   * end after this resolves). **Plan B compensation**: the total above-viewport delta (new batch measured height + ghost
   * rebuild delta) is applied once via compensateAbove (viewport does not jump). The ghost reveal and the new batch share
   * one measurePending (`measuring` suppresses onElHeight compensation → compensation is unified here). absorbBoundary is
   * called only after revalidate passes (prevents a fling-back from falsely locking noOlder → the oldest batch never
   * mounting again).
   */
  private async loadOlder(): Promise<void> {
    if (this.inflightOlder || this.noOlder || this.mounted.length === 0) return;
    this.inflightOlder = true;
    const g = this.gen;
    try {
      const cursor = this.olderCursorId();
      const batch = await this.source.getOlder(cursor, this.cfg.mountItem);
      if (this.destroyed || g !== this.gen) return; // jump re-seed overtook → drop the in-flight batch
      if (!this.revalidateTop()) return; // fling reversed during await → do not mount or absorb (phase 0: absorb boundary only after revalidate passes)
      const merged = this.mergeBatch(batch);
      if (this.destroyed || merged.length === 0) { if (merged.length === 0) this.noOlder = true; return; }
      this.absorbBoundary(merged); // phase 0: absorb boundary only after passing
      const oldGhost = this.ghostEntry;
      const oldGhostH = oldGhost ? oldGhost.height : 0;
      this.mountBatch(merged, 'older'); // prepend (no internal measure)
      let rebuildGhost = false;
      if (oldGhost && this.mounted.indexOf(oldGhost) > 0) {
        oldGhost.el.classList.remove('cb-ghost'); // must happen before rebuild swaps the el
        this.rebuildEntry(oldGhost);
        rebuildGhost = true;
      }
      this.measurePending(); // one unified measure: new batch + ghost reveal (`measuring` suppresses onElHeight compensation)
      this.flushPrefix();
      const addedPx = this.prefix[merged.length] ?? 0; // measured total height of the new batch (prepended merged.length items)
      const rebuildDelta = rebuildGhost && oldGhost ? oldGhost.height - oldGhostH : 0;
      this.compensateAbove(addedPx + rebuildDelta); // Plan B: one shot for the total above-viewport delta
      this.updateGhost();
    } finally {
      this.inflightOlder = false;
    }
    this.emit();
  }

  /** Load ONE newer batch: getNewer (cursor = newerCursorId(), the newest non-transient/optimistic mounted item) +
   *  mergeItems, then a mount-dispatch. **Pure load — no trim** (split: the caller — balance / onMessageSignal — trims
   *  the opposite end after this resolves, and onMessageSignal runs reconcileOptimistic too). Never follows — explicit
   *  go-to-bottom intent is owned by {@link followToNewest} (started from scrollToBottom); a balance-triggered call
   *  (user scrolling to the bottom edge) loads one batch and leaves the viewport put. Returns the count mounted
   *  (0 = boundary / overtaken / no data / revalidate failed). */
  private async loadNewer(force = false): Promise<number> {
    if (this.inflightNewer || this.mounted.length === 0) return 0;
    if (!force && this.noNewer) return 0;
    this.inflightNewer = true;
    const g = this.gen;
    let batch: CbItem<T>[];
    try {
      const cursor = this.newerCursorId();
      batch = await this.source.getNewer(cursor, this.cfg.mountItem);
      if (this.destroyed || g !== this.gen) return 0; // jump re-seed overtook → drop the in-flight batch
    } finally {
      this.inflightNewer = false;
    }
    if (this.destroyed || g !== this.gen) return 0;
    if (batch.length === 0) { this.noNewer = true; return 0; }
    if (!force && !this.revalidateBottom()) return 0;
    const wasAtNewest = this.noNewer;                        // pre-load edge state (transition gate for the optimistic dispatch)
    this.absorbBoundary(batch); // phase 0: absorb boundary only after passing
    // Authoritative: a newer batch reaches the global newest iff it carries the 'newest' marker. A full page WITHOUT it
    // means more newer data remains (a large WS backlog spans multiple pages) → noNewer=false so the next signal/balance
    // loads further. absorbBoundary is sticky (only ever sets true), so without this a partial backlog page left the kernel
    // falsely believing it was at the newest — stranding the remaining newer messages off-window and blocking further
    // loads (revalidateBottom is gated on !noNewer).
    this.noNewer = batch.some(it => it.boundary === 'newest');

    const count0 = this.mounted.length;

    // The batch is reals only — in-flight optimistic sends are mounted separately at the newest edge via elevatePending
    // (driven by source.getPending()). Insert reals BEFORE the optimistic/transient tail block. Each real is dispatched:
    // confirm (matches an optimistic/transient) → mounted visibly + flagged resortTarget (reconcileOptimistic removes the
    // optimistic duplicate and tags this real cb-confirmed); incoming (no match) → visible, animate (cb-enter);
    // already-mounted real (dup) → skip.
    this.mountNewerReals(this.mergeBatch(batch));

    // Symmetric optimistic lifecycle — the optimistic tail lives at the global newest edge. (Re)mount in-flight sends
    // when a page reached the newest; UNMOUNT them when a push just extended the newest (wasAtNewest && !noNewer — a
    // large backlog page landed while pinned at the newest). They are recoverable via getPending on returning to the
    // newest. The transition gate avoids touching them on ordinary scroll-back-down (noNewer was already false then).
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
   * (Re)mount in-flight optimistic sends at the global newest edge. Called by loadNewer when a page carried the
   * 'newest' marker. Driven by `source.getPending()` — the backing store — so sends unmounted by a backlog push are
   * recovered here once the newest is reached again. A pending that matches a mounted transient is promoted in place
   * (transient→optimistic); one already mounted (optimistic) is skipped; one not mounted is appended at the tail as
   * optimistic. The playground's insertAfter pre-mounts sends for immediate display, so in the common case this is a no-op.
   */
  private elevatePending(): void {
    for (const p of this.source.getPending()) {
      const idx = this.indexOfClientMsgId(p.clientMessageId);
      if (idx >= 0) {
        const e = this.mounted[idx];
        if (e.transient) { e.transient = false; e.optimistic = true; } // promote (fast-path send now seen at the edge)
      } else {
        const tail = this.mounted.length > 0 ? this.mounted[this.mounted.length - 1].item : null;
        const entry = this.createEntry(p, tail, undefined, true);
        entry.optimistic = true;
        this.mounted.push(entry);
      }
    }
  }

  /**
   * Remove every in-flight optimistic send from the mounted window. Called by loadNewer when a push extended the
   * newest (noNewer went true→false — a large backlog page landed while pinned at the newest). The sends are NOT lost:
   * they remain in the source's pending array and are re-mounted by {@link elevatePending} once the newest is reached
   * again. Synchronous (no cb-leave — mirrors reconcileOptimistic); iterate downward so splicing doesn't shift targets.
   * No scrollTop compensation (optimistic sit at the tail, at/below the fold).
   */
  private unmountAllOptimistic(): void {
    let removed = false;
    for (let i = this.mounted.length - 1; i >= 0; i--) {
      if (this.mounted[i].optimistic) { this.unmountAt(i); removed = true; }
    }
    if (removed) this.dirtyPrefix = true;
  }

  /**
   * Mount a batch of real (non-pending) items before the optimistic/transient tail block, dispatching each by whether
   * it confirms an existing optimistic/transient entry. Insertion point = right after the last real entry (= the cursor);
   * the optimistic block shifts down (it is at/below the viewport, so no scrollTop compensation is needed — pinToBottom
   * in onMessageSignal follows to reveal it). Albums already merged by the caller.
   */
  private mountNewerReals(reals: CbItem<T>[]): void {
    if (reals.length === 0) return;
    let insertIdx = this.mounted.length; // default: append at tail (no optimistic/transient block present)
    for (let i = this.mounted.length - 1; i >= 0; i--) {
      const e = this.mounted[i];
      if (!e.transient && !e.optimistic && !e.leaving && !e.resortTarget) { insertIdx = i + 1; break; }
    }
    for (const item of reals) {
      // Confirm: an in-flight optimistic/transient send whose clientMessageId matches this real. The real carries a
      // fresh server id (≠ the optimistic's clientMessageId-as-id), so the pair is matched by clientMessageId, not id.
      // No clientMessageId → a plain incoming message (no optimistic bubble to settle). An already-mounted real (dup,
      // by id — an incoming that raced with a load) is skipped.
      const confirm = this.indexOfClientMsgId(item.clientMessageId) >= 0;
      if (!confirm && this.indexOfId(item.id) >= 0) continue; // already-mounted real (dup) → skip
      const anchorEl = insertIdx < this.mounted.length ? this.mounted[insertIdx].el : null;
      const prev = insertIdx > 0 ? this.mounted[insertIdx - 1].item : null;
      const entry = this.createEntry(item, prev, anchorEl, !confirm); // incoming animates (cb-enter); a confirm mounts visibly (no enter) and is flagged for reconcileOptimistic
      if (confirm) { entry.resortTarget = true; }
      this.mounted.splice(insertIdx, 0, entry);
      insertIdx++;
    }
    this.dirtyPrefix = true;
  }

  /**
   * Optimistic-confirm reconciliation: for each just-arrived real flagged resortTarget (it confirms an in-flight
   * optimistic/transient send), immediately remove the optimistic duplicate and tag the real cb-confirmed so the
   * sent-check choreography (spinner→check→fade, scoped to these "special" items via :host(.cb-confirmed)) plays on it.
   *
   * No slide and no hiding: the real is mounted visibly at its true position (right before the optimistic tail), and this
   * whole pass runs synchronously within the loadNewer→reconcile microtask (before paint), so the momentary two-bubble
   * state (real + the optimistic duplicate beside it) is never observed — the optimistic is gone by the time the frame
   * paints. The optimistic sits at the tail (at/below the viewport), so its removal needs no above-viewport compensation
   * (the guard is retained for odd positions). Synchronous → trim's rule-4a guard never observes `resorting` true.
   */
  private async reconcileOptimistic(): Promise<void> {
    const targets = this.mounted.filter(e => e.resortTarget);
    if (targets.length === 0) return;
    this.resorting = true;
    try {
      // Pair each target (real) with its matching optimistic/transient source by clientMessageId (the real carries a
      // fresh server id ≠ the optimistic's id, so they cannot be paired by id). indexOfId would also return the target
      // itself (the real is mounted BEFORE the optimistic source), so the dedicated clientMessageId scan is required.
      const pairs: { source: Entry<T>; target: Entry<T> }[] = [];
      for (const target of targets) {
        const si = this.indexOfClientMsgId(target.item.clientMessageId);
        if (si >= 0) pairs.push({ source: this.mounted[si], target });
      }
      if (pairs.length === 0) {
        // No source mounted (e.g. a jump during pending unmounted it): the real is already visible at its true position —
        // just tag it cb-confirmed so the sent-check choreography plays.
        for (const t of targets) { t.resortTarget = false; t.el.classList.add('cb-confirmed'); }
        return;
      }
      this.flushPrefix();
      // Remove each optimistic source (the duplicate). No slide: the real is already visible beside it and this pass is
      // synchronous (before paint), so the swap reads as an in-place handoff, not a two-bubble flash.
      for (const source of pairs.map(p => p.source)) {
        const i = this.mounted.indexOf(source);
        if (i < 0) continue;
        const above = this.topOf(i) < this.viewport.scrollTop;
        const h = source.height;
        this.unmountAt(i);
        if (above) this.compensateAbove(-h); // an above-viewport row removed → content shifts up → pin the viewport
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
   * callers can `await` it uniformly. Status-morph height deltas are folded into prefix under the `measuring` guard so
   * they never trigger Plan B's compensateAbove mid-FLIP. No scrollTop compensation for the reorder itself: a pure
   * reorder within the optimistic tail leaves total height and all above-viewport positions invariant.
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
    //    the measuring guard so prefix stays honest without firing compensateAbove mid-FLIP.
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
    // Invert: each mover visually sits at its old top (new layout position + translateY(delta)).
    for (const m of movers) m.el.style.setProperty('--cb-move-dy', `${m.delta}px`);
    void this.content.offsetWidth; // force reflow so the invert start registers before the animation class is added
    // Play: add cb-move (the @keyframes animates translateY(var) → none = old top → new top). animating bumped → balance deferred.
    for (const m of movers) {
      const finish = (): void => {
        if (m.entry.moveTimer === undefined) return; // already finished (animationend + safety timeout guard)
        clearTimeout(m.entry.moveTimer); m.entry.moveTimer = undefined;
        m.el.classList.remove('cb-move');
        m.el.style.removeProperty('--cb-move-dy');
        this.onAnimEnd();
      };
      m.el.classList.add('cb-move');
      this.animating++;
      m.entry.moveTimer = setTimeout(finish, 600); // safety if animationend is swallowed
      m.el.addEventListener('animationend', finish, { once: true });
    }
  }

  /** Trim the newer end (bottom, mounted last). **Keep a buffer below the viewport**: after trimming, the content bottom
   * (totalH - h) must still be > viewport bottom (st + vh) + edge, otherwise do not trim — prevents loadOlder's
   * compensateAbove from pushing st up and then trim cutting into the viewport → st exceeds total → false atBottom
   * → loadNewer wasAtBottom jumps to the newest end. Trimming the newest end resets noNewer (loadNewer can load it back).
   * No compensation (the bottom is below the viewport). */
  private trimNewer(): void {
    if (this.resorting) return; // rule 4a: never trim during a resort (animating/hidden items must stay put)
    let trimmed = false;
    while (this.mounted.length > 1) {
      const last = this.mounted[this.mounted.length - 1];
      // Never trim an in-flight optimistic/transient send (not in the source → trimming would lose it) or an exiting
      // (leaving) item. Rule 4c: the optimistic block is atomic — reaching it aborts the trim (all-or-nothing; only
      // reconcileOptimistic removes a member, never trim). This is the "min mount height reserved" guarantee: while
      // sends sit at the tail, no bottom trim runs at all, so currently-displayed messages are never cut.
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
   * (st - h) must be > edge (symmetric to trimNewer). **Plan B compensation** scrollTop -= h. Trimming the oldest end
   * resets noOlder. */
  private trimOlder(): void {
    if (this.resorting) return; // rule 4a: never trim during a resort
    let trimmed = false;
    while (this.mounted.length > 1) {
      const first = this.mounted[0];
      // Never trim transient/optimistic/leaving, and rule 4b: never trim the global-newest real item (defensive — the
      // newest normally sits at the tail, but the guard holds regardless of position).
      if (first.transient || first.optimistic || first.leaving || first.item.boundary === 'newest') break;
      this.flushPrefix();
      const h = first.height;
      if (this.totalH() - h > this.threshold && this.viewport.scrollTop - h > this.cfg.edge) {
        this.shifting = true;
        this.unmountTop();
        this.viewport.scrollTop -= h;
        this.shifting = false;
        trimmed = true;
      } else break;
    }
    if (trimmed) this.noOlder = false;
  }

  // ---------- Height / compensation ----------

  /** Plan B: above-viewport change → scrollTop += delta (`shifting` suppresses direction misdetection). */
  private compensateAbove(delta: number): void {
    if (delta === 0) return;
    this.shifting = true;
    this.viewport.scrollTop += delta;
    this.shifting = false;
    this.lastScrollTop = this.viewport.scrollTop;
  }

  /** An element reports its real height: update the cache; if above the viewport changed, compensate. The first report inside mount/measure is skipped (reentrancy guard). */
  private onElHeight(entry: Entry<T>, h: number): void {
    if (this.destroyed) return;
    const old = entry.height;
    if (old === h) return;
    entry.height = h;
    this.dirtyPrefix = true;
    if (!this.shifting && !this.mounting && !this.measuring) {
      const idx = this.mounted.indexOf(entry);
      if (idx >= 0 && this.isAboveViewport(idx)) this.compensateAbove(h - old);
      this.scheduleBalance();
    }
  }

  /** Whether an item represents the given msgId — matches {@link CbItem.id} OR any member in {@link CbItem.ids}
   *  (so a jump to a non-head album member still resolves to its album item). */
  private itemHasId(item: CbItem<T>, id: string | number): boolean {
    const key = String(id);
    if (String(item.id) === key) return true;
    const ids = item.ids;
    return ids !== undefined && ids.some(x => String(x) === key);
  }

  /** Current index of the entry representing id (onElHeight/scrollToIndex/openAround). O(n), low frequency. */
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

  /** Oldest mounted item id that is a real source member — skips transient inserts (insertAfter), optimistic sends
   *  (in-flight pending, not in the reloadable sequence), and leaving entries (removeItem mid-exit), whose ids are not
   *  stable source cursors. Used by loadOlder so such an entry at mounted[0] doesn't make getOlder return [] and falsely
   *  lock noOlder. Callers guarantee mounted is non-empty. */
  private olderCursorId(): string | number {
    for (const e of this.mounted) if (!e.transient && !e.optimistic && !e.leaving) return e.item.id;
    return this.mounted[0].item.id; // unreachable in practice (the insert/remove target is always a real neighbor)
  }

  /** Newest mounted item id that is a real source member — skips transient/optimistic inserts and leaving entries.
   *  Symmetric to olderCursorId. */
  private newerCursorId(): string | number {
    for (let i = this.mounted.length - 1; i >= 0; i--) if (!this.mounted[i].transient && !this.mounted[i].optimistic && !this.mounted[i].leaving) return this.mounted[i].item.id;
    return this.mounted[this.mounted.length - 1].item.id;
  }

  /** Whether idx is above the viewport (its top < scrollTop). */
  private isAboveViewport(idx: number): boolean {
    return this.topOf(idx) < this.viewport.scrollTop;
  }

  private isAtBottom(): boolean {
    return this.viewport.scrollTop + this.vh >= this.content.scrollHeight - 1;
  }

  /** Scroll direction (from the scrollTop change, ±1px tolerance). Ignored during programmatic writes (`shifting`). */
  private scrollDir(st: number): 'up' | 'down' | null {
    if (this.shifting) return null;
    if (st < this.lastScrollTop - 1) return 'up';
    if (st > this.lastScrollTop + 1) return 'down';
    return null;
  }

  /** Revalidate: still at the top edge + direction not downward + oldest boundary not hit (breaks when single item and at oldest, preventing an init single-item infinite loop). */
  private revalidateTop(): boolean {
    const st = this.viewport.scrollTop;
    return st < this.cfg.edge && this.scrollDir(st) !== 'down' && !(this.mounted.length <= 1 && this.noOlder);
  }

  /** Revalidate: still at the bottom edge + direction not upward + newest boundary not hit. */
  private revalidateBottom(): boolean {
    const st = this.viewport.scrollTop;
    const total = this.totalH();
    return total - this.vh - st < this.cfg.edge && this.scrollDir(st) !== 'up' && !this.noNewer;
  }

  private absorbBoundary(items: CbItem<T>[]): void {
    for (const it of items) {
      if (it.boundary === 'oldest') this.noOlder = true;
      else if (it.boundary === 'newest') this.noNewer = true;
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
      if (this.mounted.indexOf(entry) < 0) continue; // already unmounted (guards leftovers after trim)
      const h = entry.el.offsetHeight;
      if (ngDevMode && h === 0) zeros++;
      this.onElHeight(entry, h); // `measuring` suppresses compensation + balance (loadOlder does the unified compensation)
      entry.el.classList.remove('cb-pending');
      if (entry.animate) { entry.animate = false; this.enterAnim(entry); } // cb-enter now that the element is visible
    }
    this.measuring = false;
    if (ngDevMode && (zeros > 0 || this.resetting)) console.log('[JUMP] measure n=', entries.length, 'zeroH=', zeros, 'contentScrollH=', this.content.scrollHeight);
  }

  private emit(): void { this.onScroll?.(this.getInfo()); }
}
