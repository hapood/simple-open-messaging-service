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

import type { CbSource } from './source';

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
  appendLive(items: CbItem<T>[]): void;
  getInfo(): CbScrollInfo;
  refresh(): void;
  destroy(): void;
}

const DEFAULTS: Required<CbConfig> = {
  edge: 1000, mountItem: 50, thresholdFloor: 6000, vhExtra: 2000, initBatch: 100,
};

/** Mounted entry: item (with msgId) + element handle + cached height + height unsubscribe. Fields are mutable (rebuild replaces el/vs/height/unsub). */
interface Entry<T> { item: CbItem<T>; el: HTMLElement; vs: CbElement<T>; height: number; unsub: () => void; }

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
  private mounting = false;
  private measuring = false;
  private destroyed = false;
  private dirty = false;
  private rafId = 0;
  private lastScrollTop = 0;
  private mountTick = 0;
  private unmountTick = 0;
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
    this.viewportObs = new ResizeObserver(() => { this.measureVh(); this.scheduleBalance(); });
    this.measureVh();
    this.viewportObs.observe(this.viewport);
    this.viewport.addEventListener('scroll', this.onNativeScroll, { passive: true });
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
    if (this.destroyed || this.resetting || rawItems.length === 0) return;
    // Always cache in the source (logical sequence tail) so live items keep correct cursor order for getNewer.
    const items = this.source.appendLive(rawItems);
    // Mount + follow only at the GLOBAL newest. If the newer end is trimmed (we scrolled back into history), mounting
    // at the window tail would both create a cursor-order gap and (via scrollToBottom→followToNewest) chain-jump to the
    // bottom. Cache only instead; the items load in order when the user scrolls back down.
    if (!this.noNewer) { this.emit(); return; }
    const wasAtBottom = this.isAtBottom();
    const merged = this.mergeBatch(items);
    this.absorbBoundary(merged);
    this.mountBatch(merged, 'newer');
    if (wasAtBottom) this.scrollToBottom(); // at global newest → pin to reveal the new message (no chain: noNewer is true)
    this.emit();
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
    const cursor = this.mounted[0].item.id;
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
    const cursor = this.mounted[this.mounted.length - 1].item.id;
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
    this.viewport.removeEventListener('scroll', this.onNativeScroll);
    this.unmountAll();
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

  private totalH(): number { this.flushPrefix(); return this.prefix.length > 0 ? this.prefix[this.prefix.length - 1] : 0; }

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
  private mountBatch(merged: CbItem<T>[], side: 'init' | 'older' | 'newer'): void {
    if (merged.length === 0) return;
    if (side === 'newer') {
      for (let i = 0; i < merged.length; i++) {
        const prev = i > 0 ? merged[i - 1] : (this.mounted.length > 0 ? this.mounted[this.mounted.length - 1].item : null);
        this.mounted.push(this.createEntry(merged[i], prev));
      }
    } else { // init / older both prepend (when init, mounted is empty, anchorEl = null → appendChild)
      const anchorEl = this.mounted.length > 0 ? this.mounted[0].el : null;
      const fresh: Entry<T>[] = [];
      for (let i = 0; i < merged.length; i++) {
        const prev = i > 0 ? merged[i - 1] : null;
        fresh.push(this.createEntry(merged[i], prev, anchorEl));
      }
      this.mounted.unshift(...fresh);
    }
    this.dirtyPrefix = true;
    if (side !== 'older') this.measurePending();
  }

  /** Create and mount one entry: createItem + DOM insert (before anchorEl / append) + pendingMeasure + subscribe to height. */
  private createEntry(item: CbItem<T>, prev: CbItem<T> | null, anchorEl?: HTMLElement | null): Entry<T> {
    if (ngDevMode) this.mountTick++;
    const vs = this.hooks.createItem(item, prev);
    const el = vs.el;
    el.dataset['cbId'] = String(item.id);
    if (anchorEl !== undefined && anchorEl !== null) this.content.insertBefore(el, anchorEl);
    else this.content.appendChild(el);
    const entry: Entry<T> = { item, el, vs, height: 0, unsub: () => {} }; // real height set by measurePending()
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
  private rebuildEntry(entry: Entry<T>): void {
    const idx = this.mounted.indexOf(entry);
    if (idx < 0) return;
    if (ngDevMode) this.mountTick++;
    const newPrev = idx > 0 ? this.mounted[idx - 1].item : null; // older neighbor (one index lower)
    const newVs = this.hooks.createItem(entry.item, newPrev);
    const newEl = newVs.el;
    newEl.dataset['cbId'] = String(entry.item.id);
    this.content.insertBefore(newEl, entry.el);
    this.content.removeChild(entry.el);
    entry.unsub();
    entry.vs = newVs;
    entry.el = newEl;
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

  private unmountAll(): void {
    for (const e of this.mounted) {
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

  // ---------- balance: checkpoint + loading ----------

  private onNativeScroll = () => {
    if (this.shifting || this.destroyed) return;
    this.scheduleBalance();
  };

  private scheduleBalance(): void {
    if (this.dirty || this.destroyed) return;
    this.dirty = true;
    this.rafId = requestAnimationFrame(() => { this.dirty = false; this.balance(); });
  }

  private balance(): void {
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

    if (atTop && dir !== 'down' && !this.noOlder) this.loadOlder();
    else if (atBottom && dir !== 'up' && !this.noNewer) this.loadNewer();

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
   * Load older: getOlder (cursor = mounted[0].item.id) + mergeItems + prepend mount + old-ghost reveal rebuild.
   * **Plan B compensation**: the total above-viewport delta (new batch measured height + ghost rebuild delta) is applied
   * once via compensateAbove (viewport does not jump). The ghost reveal and the new batch share one measurePending
   * (`measuring` suppresses onElHeight compensation → compensation is unified here). absorbBoundary is called only after
   * revalidate passes (prevents a fling-back from falsely locking noOlder → the oldest batch never mounting again).
   */
  private async loadOlder(): Promise<void> {
    if (this.inflightOlder || this.noOlder || this.mounted.length === 0) return;
    this.inflightOlder = true;
    const g = this.gen;
    try {
      const cursor = this.mounted[0].item.id;
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
      this.trimNewer();
      this.updateGhost();
    } finally {
      this.inflightOlder = false;
    }
    this.emit();
  }

  /** Load ONE newer batch: getNewer (cursor = last mounted item.id) + mergeItems + append + trim top (trimOlder
   *  compensates, viewport stays put). Never follows — explicit go-to-bottom intent is owned by {@link followToNewest}
   *  (started from scrollToBottom), so a balance-triggered call (user scrolling to the bottom edge) loads one batch and
   *  leaves the viewport put, symmetric to loadOlder. Returns the count mounted (0 = boundary / overtaken / no data). */
  private async loadNewer(): Promise<number> {
    if (this.inflightNewer || this.noNewer || this.mounted.length === 0) return 0;
    this.inflightNewer = true;
    const g = this.gen;
    let merged: CbItem<T>[];
    try {
      const cursor = this.mounted[this.mounted.length - 1].item.id;
      const batch = await this.source.getNewer(cursor, this.cfg.mountItem);
      if (this.destroyed || g !== this.gen) return 0; // jump re-seed overtook → drop the in-flight batch
      merged = this.mergeBatch(batch);
    } finally {
      this.inflightNewer = false;
    }
    if (this.destroyed || g !== this.gen) return 0;
    if (merged.length === 0) { this.noNewer = true; return 0; }
    if (!this.revalidateBottom()) return 0;
    this.absorbBoundary(merged); // phase 0: absorb boundary only after passing
    this.mountBatch(merged, 'newer'); // append (measure at end)
    this.trimOlder(); // trim top + Plan B compensate scrollTop -= h (keeps the viewport on the same content)
    this.updateGhost();
    this.emit();
    return merged.length;
  }

  /** Trim the newer end (bottom, mounted last). **Keep a buffer below the viewport**: after trimming, the content bottom
   * (totalH - h) must still be > viewport bottom (st + vh) + edge, otherwise do not trim — prevents loadOlder's
   * compensateAbove from pushing st up and then trim cutting into the viewport → st exceeds total → false atBottom
   * → loadNewer wasAtBottom jumps to the newest end. Trimming the newest end resets noNewer (loadNewer can load it back).
   * No compensation (the bottom is below the viewport). */
  private trimNewer(): void {
    let trimmed = false;
    while (this.mounted.length > 1) {
      this.flushPrefix();
      const h = this.mounted[this.mounted.length - 1].height;
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
    let trimmed = false;
    while (this.mounted.length > 1) {
      this.flushPrefix();
      const h = this.mounted[0].height;
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
    }
    this.measuring = false;
    if (ngDevMode && (zeros > 0 || this.resetting)) console.log('[JUMP] measure n=', entries.length, 'zeroH=', zeros, 'contentScrollH=', this.content.scrollHeight);
  }

  private emit(): void { this.onScroll?.(this.getInfo()); }
}
