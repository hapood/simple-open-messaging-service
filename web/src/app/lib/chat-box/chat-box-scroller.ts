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
 * Development diagnostics are guarded by Angular's public `isDevMode()` API.
 */
import { isDevMode } from '@angular/core';

import type { CbSource } from './cb-source';


export interface CbItem<T = unknown> {
  /** Real data id (the msgId from the source). Only a source cursor + read by createItem for data; **takes no part in position arithmetic** (kernel position uses the array index). */
  id: number;
  data: T;
  /** Boundary marker (assigned by the source): 'oldest' = global oldest, 'newest' = global newest, 'both' = a sole
   *  item that is BOTH the global oldest and newest (a single-message thread, or a length-1 init batch spanning the
   *  whole sequence — the field is single-valued, so without 'both' the source's items[0]='oldest' / items[last]='newest'
   *  would collide on the same item and lose the oldest marker, leaving noOlder unset → permanent top ghost). */
  boundary?: 'oldest' | 'newest' | 'both';
  /**
   * All member msgIds an aggregated item (e.g. album) represents — populated by the mergeItems hook
   * when it merges several msgs into one item (the first member equals {@link id}). Single (non-merged)
   * items leave this undefined. Purpose: id resolution for jump/positioning (scrollToIndex, indexOfId)
   * must land on the album item when the target is any album member — otherwise jumping to a non-head
   * image's msgId fails to find it (item.id only carries the head) and the viewport ends up empty
   * (jump-to-id bug). Read-only in the kernel; the source returns raw msgs and never sets this.
   */
  ids?: (number)[];
  /**
   * Client-generated idempotency UUID for an optimistic send — the correlation key between the in-flight
   * optimistic transient and the confirmed real the server echoes back. Present on BOTH: the optimistic item
   * (where {@link id} is also this uuid — no server msgId exists yet) and the confirmed real (where {@link id}
   * is the FRESH server msgId). The kernel reconciles the pair by THIS key, NOT by id — id-equality cannot
   * pair them, since the real carries a brand-new server id. Absent on history/incoming messages that did not
   * originate as an optimistic send. Mirrors `Message.clientMessageId` (the persisted idempotency column).
   */
  clientMessageId?: string;
  /**
   * ALL clientMessageIds this real item fulfills — i.e. every in-flight optimistic send whose content is now part of
   * this item (the head's cid is also in {@link clientMessageId}). Populated by the merge/absorb hooks when they combine
   * same-creator IMAGE reals into one album, so a confirmed album can reconcile EVERY member's optimistic bubble, not
   * just the head's. Absent when the item fulfills at most one optimistic (the singular {@link clientMessageId} already
   * covers it) and on incoming/history messages that did not originate as an optimistic send. The kernel reads this for
   * confirm-detection (mountNewerReals) and duplicate-removal (reconcileOptimistic); the source never sets it.
   */
  clientMessageIds?: string[];
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
  /** Skeleton placeholder for the topmost slot (mounted[0]) when the older edge is NOT yet reached (a loading spinner
   *  while loadOlder fetches older history). The KERNEL owns the decision of WHEN a slot is a skeleton (it knows prev,
   *  item.boundary, and noOlder — see createVs); createItem only ever renders REAL items. Supplying this hook opts the
   *  consumer into skeleton rendering; when absent the kernel falls back to createItem for the slot (no skeleton).
   *  Generic (T = unknown): the kernel never imports a concrete spinner — the consumer provides the pixels. */
  createSkeleton?: (item: CbItem<T>) => CbElement<T>;
  /** Called on each source batch before createItem: presentation aggregation (e.g. merge consecutive same-creator IMAGE msgs into an album). Default noop. scope = batch (per-batch, cut across batches). */
  mergeItems?: (items: CbItem<T>[]) => CbItem<T>[];
  /** Cross-batch album absorb: when a newer batch's item would mount right after the running newest real, the kernel asks
   *  this hook whether `incoming` should ABSORB INTO `target` (the current newest mounted item) instead of mounting as a
   *  new bubble. Return the merged item (target's data with incoming folded in, member ids unioned, AND clientMessageIds
   *  unioned — see {@link CbItem.clientMessageIds}) to morph `target` in place, or null to mount `incoming` normally. The
   *  hook owns all domain knowledge (same-creator IMAGE, album cap, etc.); the kernel stays domain-agnostic. Evaluated per
   *  item against the live newest (no sticky mode — a non-absorbable item naturally ends the run by becoming the new
   *  newest). Both confirms and plain incoming are offered: when the absorbed item is a confirm (an in-flight optimistic
   *  send), its cid on the merged item lets reconcileOptimistic remove the matching optimistic bubble — the image joins
   *  the album instead of mounting a separate bubble beside it. Default noop (treated as null). */
  absorbTail?: (target: CbItem<T>, incoming: CbItem<T>) => CbItem<T> | null;
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
  /** Finish init after the first source page instead of awaiting older-page viewport fill. The caller can
   *  invoke backfillOlder() after revealing the thread, keeping first paint independent of network latency. */
  deferInitFill?: boolean;
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
  /** Immunity-frame predicate: while it returns true, {@link onViewportResize} defers
   *  (sets a pending flag and returns) instead of reflowing. Used by the route-transition
   *  freeze so the message list does not re-pin/balance mid-slide. The caller MUST call
   *  {@link flushViewportResize} once after the predicate flips back to false so the
   *  deferred resize is applied. Defaults to "never frozen". */
  isFrozen?: () => boolean;
}

export interface CbScrollInfo {
  scrollTop: number;
  scrollHeight: number;
  viewportHeight: number;
  /** Mounted window boundary item.id (msgId). */
  oldestId: number | null;
  newestId: number | null;
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
  oldestId: number | null;
  newestId: number | null;
  inflightOlder: boolean;
  inflightNewer: boolean;
}

/** init() options: jump / re-anchor (open at a specific message). */
export interface CbInitOpts {
  /** Fetch bidirectionally with this msgId as the anchor (default none = first screen from global newest). */
  startMsgId?: number | null;
  /** How the target aligns in the viewport (default 'center'). */
  anchor?: 'top' | 'center' | 'bottom';
  /** Add a one-shot highlight flash to the target after positioning (default false). */
  highlight?: boolean;
}

/**
 * Scroll anchor — the stable "where should scrollTop be" intent that survives across content mutations. scrollTop is
 * DERIVED from it by {@link ChatBoxScroller.applyAnchor}, never nudged imperatively at each mutation site.
 *
 *  - `bottom`: follow the global content bottom (the newest). Used for live arrivals / sends while pinned.
 *  - `item`: keep `id` at a fixed `offset` from the viewport top (offset = scrollTop - topOf(id), signed). Any
 *    above-viewport growth shifts topOf(id) and applyAnchor follows automatically — this is the manual equivalent of
 *    the browser's overflow-anchor (Plan A leans on the browser for this; Plan B does it by hand here).
 *
 * `fallbackId` (the entry right below the anchor at capture) rescues the case where the anchored entry itself is
 * removed (leaveEntry / reconcileOptimistic): it shifts into the anchor's old slot, so topOf(fallback)+offset is the
 * same preserved position. Null at the tail / when there is no successor.
 */
export type Anchor =
  | { mode: 'bottom' }
  | { mode: 'item'; id: number; offset: number; fallbackId: number | null };

/** Public kernel capabilities (satisfied by both Plan A/B). */
export interface ScrollerApi<T = unknown> {
  /** First-screen load; if opts.startMsgId is given, open at that message (re-anchor), otherwise lay out from the global newest. */
  init(opts?: CbInitOpts): Promise<void>;
  /** Fetch and prepend one older page after a deferred first paint. Preserves the current viewport anchor. */
  backfillOlder?(): Promise<void>;
  scrollToBottom(): void;
  scrollToTop(): void;
  /** Jump to id: if mounted, position directly; if not, reset the window around the id (re-seed) then position. anchor defaults to 'center'. highlight adds a one-shot flash to the target. */
  scrollToIndex(id: number, anchor?: 'top' | 'center' | 'bottom', highlight?: boolean): void;
  /** Insert a single item immediately after the mounted entry representing afterId. No-op (returns false) if afterId
   *  is not currently mounted or a re-seed is in progress. Does NOT trigger balance (no checkpoint load, no trim) —
   *  Plan B only compensates scrollTop for any growth above the viewport so the viewport stays put; Plan A relies on
   *  overflow-anchor. By default the inserted item is transient (viewport-only, not registered with the source: a
   *  debug FAKE insert). Pass {optimistic:true} for a pending send — the entry is marked optimistic (in source.pending,
   *  returned by getNewer; skipped by cursors; protected from trim as part of the atomic optimistic block). */
  insertAfter(afterId: number, item: CbItem<T>, opts?: { optimistic?: boolean }): boolean;
  /** Remove mounted entries by id — accepts one id or an array. A fake-id, pending-id, real-id, or any album-member id
   *  all resolve to the same mounted entry (album-aware). Each removed entry plays a cb-leave exit animation; the logical
   *  unmount is deferred to animationend. Returns the count of entries scheduled for removal (0 = none mounted). */
  removeItem(ids: number | (number)[]): number;
  /** Direct-mount path for live items (incoming messages). Caches via source.pushLive, then mounts the items at the
   *  tail (dedup by id; follows to the bottom if pinned). Production SSE and the playground's incoming-reply path use
   *  this. NOT the optimistic-confirm path — that goes through {@link onMessageSignal} (which pulls via getNewer and
   *  runs reconcileOptimistic). */
  appendLive(items: CbItem<T>[]): void;
  /** Signal that new messages are available (source already cached them via pushLive). If the kernel still mounts the
   *  global newest, pulls the new items via loadNewer (getNewer), runs reconcileOptimistic (remove any optimistic sends
   *  whose real counterpart arrived, tagging the real cb-confirmed), follows to the bottom if pinned, and trims. If the
   *  newer end is trimmed, this is a no-op (the items are cached; loaded on scroll-back). */
  onMessageSignal(seq?: number): Promise<void>;
  /** Re-sync the mounted optimistic/pending entries to the source's current `getPending()` snapshot — the entry point
   *  the caller uses after mutating the pending store (e.g. marking a send failed and sinking it to the end). For each
   *  mounted optimistic entry: morphs its data in place via `CbElement.update` (no remount) when the status changed,
   *  reorders the optimistic tail block to match the source order, and FLIP-animates (cb-move) every entry whose
   *  absolute top changed. No I/O (pure re-read of getPending). No-op when no optimistic entries are mounted. */
  reconcilePending(): Promise<void>;
  /** Flip an in-flight optimistic send to "sent" IN PLACE — morph the entry to the source's fresh status:'sent'
   *  snapshot and tag the element cb-confirmed so the spinner→check→fade choreography plays with NO mount/unmount
   *  and NO reorder (a sent send stays at its tail position). This decouples the delivery-confirm visual (fired at
   *  the HTTP-200 / upload-success milestone) from the SSE-echo reconcile (which still owns the real's mount + the
   *  cb-move FLIP). Single-trigger: no-op if the optimistic was already swapped out (the SSE echo won the race) OR
   *  already confirmed (the cb-confirmed class is present) — so the choreography fires exactly once. */
  confirmPending(clientMessageId: string): void;
  getInfo(): CbScrollInfo;
  refresh(): void;
  /** Re-render one mounted item's data IN PLACE (no remount, no height re-measure) — for a data-only
   *  change whose presentation never alters the cell's measured height (e.g. a mediaStatus flip: the
   *  status overlay + meta slot are height-neutral). Album-aware via {@link indexOfId}: any member id
   *  resolves to the album item. Morphs through `CbElement.update` (the same path reconcilePending uses
   *  for a status morph) with the patched data and the unchanged prev neighbor; because the height is
   *  unchanged, no reflow, no anchor shift, no onHeightChange fires. Returns false when the item is not
   *  currently mounted (the next mount carries the patched data from IDB — a no-op is safe). */
  updateItemData(id: number, patch: Partial<T>): boolean;
  /** Apply a viewport resize that was deferred during an immunity frame (see
   *  {@link CbOptions.isFrozen}). No-op if nothing was deferred. */
  flushViewportResize(): void;
  destroy(): void;
}

const DEFAULTS: Required<CbConfig> = {
  edge: 1000,
  mountItem: 50,
  thresholdFloor: 6000,
  vhExtra: 2000,
  initBatch: 100,
  deferInitFill: false,
};

/** Safety timeout backing the enter/leave/move CSS animations (cb-enter/cb-leave/cb-move in _cb.scss). Must exceed the
 *  longest CSS duration (~0.22s for cb-move); 0.45s leaves a ~230ms margin for a swallowed animationend to self-clear
 *  without the lag the old 0.6s backstop added now that the animations themselves are snappier. */
const ANIM_SAFETY_MS = 450;

/** Maximum tolerated drift (px) between the kernel height model (totalH = Σ integer offsetHeight + tailCap) and the
 *  live content.scrollHeight, asserted only in the dev-mode integer-height check. Under the integer line-height contract
 *  (CLAUDE.md: every height-contributing value is integer px) the two agree up to a single rounding seam, so 1 px is the
 *  expected envelope. A larger |d| means a row is rendering at a fractional height — the warning re-points at _row-base.
 *  This is a dev-only regression guard; runtime comparisons carry their own tolerances (≥1 px; balance uses cfg.edge). */
const VS_DRIFT_TOLERANCE_PX = 1;

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

/**
 * Kernel lifecycle (category A) — the mutually-exclusive phase the kernel is in. Replaces the former `resetting` +
 * `destroyed` boolean pair with a single typed field so the public-method guards read as intent and the state graph is
 * explicit. `gen` is a SEPARATE counter (it carries fill *identity* across nested/overtaking re-seeds — it is not a
 * state, so two re-seeds can both be `filling` and the loser is told apart by `g !== this.gen`).
 *  - 'filling'   — an `openAround` re-seed body is executing (between `resetWindowState` and `openAround`'s finally).
 *                  The public *mutation* entry points (appendLive/insertAfter/removeItem/onMessageSignal/
 *                  reconcilePending) drop their input here: already cached via source.pushLive / source.pending,
 *                  recovered on scroll-back. (A plain first-screen `init()` does NOT enter `filling` — see init.)
 *  - 'steady'    — normal operation (also the initial state from construction, before the first `init`).
 *  - 'destroyed' — terminal; every public method is a no-op.
 * Only three transitions: openAround's resetWindowState steady→filling, openAround's finally filling→steady,
 * destroy() *→destroyed. */
export type KernelState = 'filling' | 'steady' | 'destroyed';

export class ChatBoxScroller<T = unknown> implements ScrollerApi<T> {
  private readonly viewport: HTMLElement;
  private readonly content: HTMLElement;
  private readonly hooks: CbHooks<T>;
  private readonly source: CbSource<T>;
  private readonly cfg: Required<CbConfig>;
  private readonly initOpts: { chatId?: number };
  private readonly onScroll?: (info: CbScrollInfo) => void;
  private readonly onDebug?: (stats: CbDebugStats) => void;
  private readonly isFrozen: () => boolean;

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
  private readonly tailCapObs: ResizeObserver = new ResizeObserver(() =>
    this.onTailCapResize(),
  );
  private inflightOlder = false;
  private inflightNewer = false;
  /** Reset generation: incremented by openAround; compared after the await in loadOlder/loadNewer so stale batches are not mounted (guards against a jump overtaking an in-flight load). */
  private gen = 0;
  /** Kernel lifecycle (category A); see {@link KernelState}. */
  private state: KernelState = 'steady';
  /** Derived phase questions (read-only views over {@link state} — single source of truth, cannot drift). Getters, not
   *  flags, so each access is a FRESH read: the many post-`await` `destroyed` checks stay correct even though TypeScript
   *  (unsoundly) narrows a mutable member across `await`. */
  private get steady(): boolean { return this.state === 'steady'; }
  private get filling(): boolean { return this.state === 'filling'; }
  private get destroyed(): boolean { return this.state === 'destroyed'; }
  /** Debug switch: turn off the mount checkpoint (balance will not trigger loadOlder/loadNewer). Guarded by isDevMode() inside balance → removed in prod AOT. Default false (checkpoint loads normally). */
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
  /** Set when onViewportResize was called while {@link isFrozen} (immunity frame) and thus skipped.
   *  flushViewportResize applies it once on thaw so a real viewport change during the freeze is not lost. */
  private resizeDeferred = false;
  private mounting = false;
  private measuring = false;
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
   *  on `inflightNewer`, so its pushLive'd items never drain (orphaned in the live cache until the NEXT signal), and both
   *  calls' flipMove overlap on the surviving optimistic tail (moveTimer overwritten → animating leaks; the shove
   *  double-plays). Tail-coalescing makes the pair run strictly in order, which is the only correct interleaving for an
   *  async handler that mutates mount order, the height model, and scrollTop. */
  private signalInFlight = false;
  private signalQueued = false;
  /** True once the first {@link init} has mounted its initial batch + established `noNewer` — the kernel has
   *  "primed." Before priming, a `!noNewer` state is the init-fetch window (the initial `source.init(-1)` HTTP
   *  call is in flight); AFTER priming it means the user scrolled up (the newer end is trimmed). Only the
   *  former must not lose a signal (its message may have missed the init snapshot) — the latter correctly
   *  caches for scroll-back. {@link pendingSignalBeforePrimeSeq} tracks the max-seq signal during the window. */
  private primed = false;
  /** The highest seq of a signal that arrived during the init-fetch window (before priming), or null. Each
   *  arrival keeps the MAX (compare-before-set); a seq-less signal counts as +∞ so it still forces a replay.
   *  {@link primeAndReplay} replays once iff this is newer than what init already mounted. */
  private pendingSignalBeforePrimeSeq: number | null = null;
  /** Set during reconcileOptimistic. Reconcile is synchronous (no slide animation) and never spans an await, so this is
   *  never observed true by a deferred trim — kept so trimOlder/trimNewer (rule 4a) stay self-documenting. */
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
    if (startId !== null) { await this.openAround(startId, opts?.anchor ?? 'center', opts?.highlight ?? false); this.primeAndReplay(); return; }
    const batch = await this.source.init(-1, this.cfg.initBatch, 0, this.initOpts);
    // A teardown / re-init can overtake this scroller during the await (the coordinator's teardownKernel/reset→reinit
    // fires while the fetch is in flight, destroy()ing this one and handing the shared content element to a newer
    // scroller). openAround guards this with a gen check after its await; the normal-init path must too — WITHOUT
    // it, a dead scroller proceeds to mountBatch and injects its rows into content a newer scroller now owns, where
    // they sit outside every live mounted[] as immortal orphans (inflating scrollHeight past totalH). Bail before
    // touching the DOM; the owning scroller mounts its own batch.
    if (this.destroyed) return;
    const merged = this.mergeBatch(batch);
    if (merged.length === 0) {
      // Empty thread: the empty sequence is trivially at BOTH edges. Marking noOlder/noNewer here is what makes an
      // empty chat report "pinned to bottom" (noNewer) — without it, an optimistic send is mis-routed through the
      // trimmed-newer queue path (dispatchPending → scrollToBottom → followToNewest), which can never drain on an
      // empty thread, so the first message never mounts. Mirrors the normal init tail (scrollToBottom + updateGhost).
      this.noOlder = true;
      this.noNewer = true;
      this.scrollToBottom();
      this.updateGhost();
      this.emit();
      this.primeAndReplay();
      return;
    }
    this.absorbBoundary(merged);
    this.mountBatch(merged, 'init');
    // Prime ghostEntry BEFORE the fill loop: loadOlderIntoFresh captures this.ghostEntry (NOT mounted[0]) as the slot to
    // rebuild on each prepend, and ghostEntry is null until the first updateGhost. Without this prime the init batch's top
    // skeleton (created by mountBatch above) would never be rebuilt on the first prepend → a stuck spinner mid-list.
    // Also covers the no-fill case (the init batch already exceeds the threshold → the loop never runs).
    this.updateGhost();
    // Pin to the bottom BEFORE the multi-batch fill, and re-pin after each prepend. Each batch load awaits the source
    // (a network call in production, a setTimeout in the mock) — a macrotask boundary, so the browser paints between
    // batches. Without these pins the first paint shows the window top (the oldest end of the init batch, not the global
    // newest), each uncompensated prepend then drifts the viewport further up, and only the final scrollToBottom lands
    // at the bottom — the visible "show some messages, then flash to another batch" glitch. Mirrors openAround's
    // positionMounted-before-fill + fillAround's per-batch pin(): a prepend grows content above the bottom anchor, and
    // applyAnchor({mode:'bottom'}) reads the LIVE content.scrollHeight so it follows that growth and keeps the newest
    // in view across every inter-batch paint.
    this.pinToBottom();
    // Fill to threshold via the SAME primitive openAround's building fill uses (loadOlderIntoFresh: prepend + ghost-reveal
    // rebuild + measure in one pass, no compensation — the per-batch pinToBottom above owns viewport stabilization).
    // Sharing the load path — instead of open-coding a second prepend here — is what keeps init fill and scroll-up
    // loadOlder from drifting apart; the prior divergence left a spinner stuck at the batch boundary on multi-batch init
    // fills. The gen guard inside makes a concurrent jump (openAround bumps gen) overtake the in-flight fill cleanly.
    while (
      !this.cfg.deferInitFill &&
      this.totalH() < this.threshold &&
      !this.noOlder &&
      this.mounted.length > 0
    ) {
      if (await this.loadOlderIntoFresh(this.gen) === 0) break; // 0 = boundary reached / no data / overtaken by a jump
      this.pinToBottom(); // a prepend grew content above → re-pin to the new bottom before the next async fetch yields to the painter
    }
    this.scrollToBottom();
    this.primeAndReplay();
  }

  async backfillOlder(): Promise<void> {
    if (
      this.destroyed ||
      !this.steady ||
      this.noOlder ||
      this.mounted.length === 0
    )
      return;
    // A deferred production init normally reveals a short, bottom-pinned local page. Preserve that
    // exact intent while one remote page is prepended; after this page, ordinary scroll checkpoints
    // own any further pagination.
    const anchor = this.captureAnchor();
    const mounted = await this.loadOlderIntoFresh(this.gen);
    if (mounted > 0 && !this.destroyed) this.applyAnchor(anchor);
  }

  appendLive(rawItems: CbItem<T>[]): void {
    if (this.destroyed || rawItems.length === 0) return;
    // Direct-mount path for live items (production SSE incoming). Cache via pushLive, then mount at the tail. This path
    // does NOT reconcile optimistic sends — production has none, and the playground routes its live messages (incoming +
    // optimistic confirm) through onMessageSignal, which inserts reals at their true position and reconciles. Dedup by id
    // (an incoming that raced with a load is already mounted → skip).
    this.source.pushLive(rawItems);
    if (this.filling) { this.emit(); return; }   // re-seed in progress: cached; mount on scroll-back
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
  async onMessageSignal(seq?: number): Promise<void> {
    if (!this.steady) return;
    // Single-flight + tail-coalesce: two SSE frames can land in the same microtask window (two onSignal
    // callbacks back-to-back). Running them concurrently races on shared state — the second's loadNewer bails on
    // inflightNewer (orphaning its items off-window) and both flipMove the optimistic tail (leaking `animating`
    // and double-playing the shove). Collapse any overlap into ONE tail pass after the in-flight pass resolves, looping
    // until no further signal arrived during a pass (drains a whole burst, in arrival order, strictly non-overlapping).
    if (this.signalInFlight) { this.signalQueued = true; return; }
    this.signalInFlight = true;
    try {
      do {
        this.signalQueued = false;
        await this.runMessageSignal(seq);
      } while (this.signalQueued && this.steady);
    } finally {
      this.signalInFlight = false;
    }
  }

  /** Mark the kernel primed (first init/jump completed) and replay a signal that arrived during the
   *  init-fetch window (saved by {@link runMessageSignal}'s `!primed` branch). Called at the end of {@link init}. */
  private primeAndReplay(): void {
    this.primed = true;
    const pendingSeq = this.pendingSignalBeforePrimeSeq;
    this.pendingSignalBeforePrimeSeq = null;
    if (pendingSeq === null || this.destroyed) return;
    // Replay only if the saved high-water seq is NEWER than what init mounted — a signal for a message the
    // snapshot already had (seq ≤ newest mounted) needs no catch-up. Empty window (no mounted items) replays.
    const newestMounted = this.mounted.length > 0 ? this.mounted[this.mounted.length - 1].item.id : -Infinity;
    if (pendingSeq > newestMounted) void this.onMessageSignal();
  }

  private async runMessageSignal(seq?: number): Promise<void> {
    if (!this.noNewer) {
      // Newer edge not mounted. Two cases, told apart by `primed` (true once the first init has run):
      //  • !primed → the init-fetch window (the initial source.init(-1) HTTP call is still in flight, noNewer
      //    not yet set). A signal here must NOT be lost — its message may have missed the init snapshot. Save
      //    it (coalesced: the latest arrival wins, earlier ones just re-set the flag) for init to replay once.
      //  • primed → the user scrolled up (newer end trimmed). Dropping is correct — the message is cached and
      //    loads on scroll-back. (loadNewer is cursor-based, so the single replay catches every window message
      //    regardless of how many signals fired.)
      if (!this.primed) {
        // Save the highest seq seen during the window (compare-before-set → keep the max; a seq-less signal
        // counts as +∞ so it still forces the replay).
        this.pendingSignalBeforePrimeSeq = Math.max(this.pendingSignalBeforePrimeSeq ?? -Infinity, seq ?? Infinity);
      }
      return;
    }
    const wasAtBottom = this.isAtBottom();

    // Coordinated enter/shove animation — FLIP "First": snapshot the optimistic tail's absolute tops at their LAST
    // PAINTED position (before loadNewer inserts the new reals above them and reconcile removes any confirmed duplicate).
    // After those mutations, flipMove replays the surviving tail from these tops to its new position (the shove) in the
    // same synchronous task as the new reals' cb-enter-above (started in measurePending), so the pair shares one frame.
    // The await on getNewer never mutates the optimistic tail, so this snapshot stays valid across it.
    const tailBefore = this.mounted.filter(e => e.optimistic && !e.leaving);
    const tailOldTop = new Map<Entry<T>, number>();
    if (tailBefore.length > 0) {
      this.flushPrefix();
      for (const e of tailBefore) tailOldTop.set(e, this.topOf(this.mounted.indexOf(e)));
    }

    const n = await this.loadNewer(true);                   // forced: the signal means new data is available; returns mounted + absorbed count (0 = nothing new this pass — mirrors the `n` used in followToNewest; an absorbed-only batch counts > 0 so its optimistic still gets reconciled)
    if (this.destroyed) return;
    if (n === 0) return;                                    // nothing new mounted or absorbed → no shove to play, no new bottom to follow. Common for the tail-coalesced follow-up pass: by the time it runs, the in-flight pass already drained the live cache, so this one has nothing to do (also covers a genuine source-empty result). Safe to skip reconcileOptimistic/flip/trim/pin: mountNewerReals did not run (nothing was mounted AND nothing absorbed), so there is nothing to reconcile.
    await this.reconcileOptimistic();                       // remove optimistic duplicates (synchronous) so the bottom is final
    if (this.destroyed) return;

    // FLIP "Play": animate the surviving optimistic tail from its pre-batch tops (the shove). No-op when nothing remains
    // (single-send confirm: the lone pending was the removed duplicate) or when heights match (delta 0 → skipped), which
    // is the common case since a real confirms an optimistic of the same content. Runs before trim/ghost/cap, which only
    // touch the top end and do not affect the tail's layout positions.
    if (tailOldTop.size > 0) {
      this.flipMove(this.mounted.filter(e => e.optimistic && !e.leaving), tailOldTop);
    }

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
  insertAfter(afterId: number, item: CbItem<T>, opts?: { optimistic?: boolean }): boolean {
    if (!this.steady) return false;
    // Empty window: there is no anchor to insert "after", so the item becomes the sole entry (prev=null). This is the
    // first-message-in-an-empty-thread path — afterId is irrelevant there (and typically '' / the optimistic's own id,
    // since tailAnchorId() is empty when nothing is mounted). animate=true: a new message is appearing.
    if (this.mounted.length === 0) {
      const anchor = this.captureAnchor();
      const entry = this.createEntry(item, null, null, true);
      if (opts?.optimistic) entry.optimistic = true;
      else entry.transient = true;
      this.mounted.push(entry);
      this.dirtyPrefix = true;
      this.measurePending();
      this.applyAnchor(anchor);
      this.updateTailCap(); // mounted 0→1 (e.g. first pending in an empty thread): flip the cap hidden→gap so the bottom padding shows
      return true;
    }
    const idx = this.indexOfId(afterId);
    if (idx < 0) return false;                  // not mounted → neglect the insert request
    // Capture the anchor BEFORE the insert: an insert above the topmost-visible item pushes it down, and applyAnchor
    // follows (the fold content stays put); an insert at/below the fold leaves the anchor's topOf unchanged → no shift.
    // This replaces the two per-delta compensateAbove checks (new item + successor rebuild) with one anchor re-apply.
    const anchor = this.captureAnchor();
    const target = this.mounted[idx];
    const successor = this.mounted[idx + 1] ?? null;
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
    this.measurePending();                       // `measuring` suppresses onElHeight → unified applyAnchor below
    this.applyAnchor(anchor);                     // above-fold insert pushed the fold → anchor follows; below-fold → no-op
    this.updateTailCap();                         // keep the newer-edge cap in sync after a mounted mutation
    return true;
  }

  /**
   * Remove mounted entries by id (fake/pending/real, or any album-member id). Accepts one id or an array. Each removed
   * entry plays a cb-leave exit animation; the logical unmount is deferred to animationend (the entry STAYS in mounted[],
   * height still counted, until then — so the height model stays exact). No `animating>0` guard: removes run concurrently
   * with each other and with inserts; only balance is gated by animating. Returns the count scheduled for removal.
   */
  removeItem(ids: number | (number)[]): number {
    if (!this.steady) return 0;
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

  /** Start one entry's cb-leave exit: mark leaving, animating++, and kick the class off on the next rAF (consistent
   *  with enter/move — every animation begins on a frame boundary). cb-leave's `from` (opacity:1) matches the entry's
   *  current visible state, so the one-frame deferral is invisible. Completion (unmount + Plan B scrollTop compensate)
   *  runs on animationend or the safety timeout. leaveRaf (rAF pending) and leaveTimer/leaveDone (running) are handled
   *  by cancelEntryAnim. */
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
        if (i >= 0) {
          // Capture BEFORE unmount: an above-fold removal shifts content up and the anchor follows (the fold stays put);
          // a below-fold removal leaves the anchor's topOf unchanged (no shift); if the leaving row WAS the anchor, its
          // fallbackId successor takes the slot. Replaces the compensateAbove(-h) + above-fold check.
          const anchor = this.captureAnchor();
          this.unmountAt(i);
          this.applyAnchor(anchor);
        }
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
    // Newest end trimmed (window moved back, noNewer=false) → load back to the global newest. The follow chain is
    // explicit go-to-bottom intent (followToNewest); balance-triggered loadNewer never follows, so scrolling to the
    // bottom edge only loads one batch and leaves the viewport put (symmetric to loadOlder).
    if (!this.noNewer) void this.followToNewest();
  }

  /** Position the viewport at the content bottom — the bottom {@link Anchor}, applied via {@link applyAnchor}
   *  (compensation-safe via `shifting`; suppresses its own async scroll event). */
  private pinToBottom(): void {
    this.applyAnchor({ mode: 'bottom' });
  }

  /** Stabilize every asynchronous tail-cap mutation (upload aggregate, responsive content, fonts).
   * Capture against the old measured cap height, then apply after reading the new DOM height: a
   * bottom-pinned viewport follows the growth, while a reader above the bottom keeps their item anchor. */
  private onTailCapResize(): void {
    const el = this.tailCapEl;
    if (!el || this.destroyed) return;
    const nextH = el.offsetHeight;
    if (nextH === this.tailCapH) return;
    const anchor = this.captureAnchor();
    this.tailCapH = nextH;
    this.applyAnchor(anchor);
    this.emit();
  }

  /**
   * Snapshot the current viewport position as an {@link Anchor}, to re-apply after a content mutation. Call BEFORE
   * the mutation (so topOf/totalH reflect the pre-change layout). The anchor encodes "keep the visible content put":
   * at-bottom ⇒ follow the bottom; otherwise ⇒ hold the topmost-visible item at its current offset.
   *
   * The at-bottom test uses the KERNEL height model (totalH) inline, NOT isAtBottom()/content.scrollHeight: when
   * called from onElHeight the DOM already reflects the new height (a real ResizeObserver fires post-layout; the mock
   * updates the height map before the cb), so content.scrollHeight is the POST-change value and would falsely read
   * not-at-bottom for a tail growth. totalH() here still holds entry's OLD height (the mutation is below) → the true
   * pre-change bottom. (For the other stabilization sites, capture runs before the mutation when DOM ≡ kernel model,
   * so the two bases agree.)
   *
   * Rejects the bottom anchor while heights are unsettled (pendingMeasure > 0): a just-created/rebuilt entry has
   * height 0, which would make totalH() artificially low and the at-bottom test falsely true.
   */
  private captureAnchor(): Anchor {
    if (this.steady && this.pendingMeasure.length === 0
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
   * The ONE place `scrollTop` is written for stabilization/positioning. Derives it from the anchor:
   *  - `bottom` ⇒ content.scrollHeight - vh (LIVE DOM — immune to prefix staleness; matches the old pinToBottom).
   *  - `item`  ⇒ topOf(id) + offset (prefix[]). If the anchored id was removed, fall back to fallbackId (the successor
   *    that shifted into its slot) with the same offset; if that is gone too, leave scrollTop unchanged.
   * Clamps to [0, content.scrollHeight - vh] (matches the old positionMounted clamp). Guarded against the destroyed state.
   *
   * NOTE: intentionally NOT guarded against the `filling` state — positioning pins (positionMounted from openAround's
   * early pin + fillAround's per-batch re-pin) run DURING a re-seed (state === 'filling') and must write. The
   * stabilization sites (onElHeight/loadOlder/trim/insertAfter/leaveEntry/reconcileOptimistic) are simply never reached
   * while filling:
   * fill uses the compensate-free `*IntoFresh` variants, and measurePending (which can call onElHeight) runs under the
   * `measuring` guard that skips the stabilization branch. So no stabilization applyAnchor fires mid-reseed anyway.
   *
   * Does NOT set the suppressScrollBalance one-shot: every pin/follow site that routes through here has noNewer=true
   * (onMessageSignal/appendLive/followToNewest all gate on it), so the post-write scroll event arms a balance whose
   * loadNewer is a harmless no-op (and dirty+inflight bound any re-entry). The ONE site that pins with noNewer=false
   * — onViewportResize — keeps its own manual suppress set (a shrink at a trimmed bottom would otherwise loadNewer
   * and jump). In a real browser the pin's own scroll event consumes that flag; jsdom tests don't auto-fire it, so a
   * global suppress here would wrongly swallow the next test-dispatched scroll.
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

  /** Index of the topmost item whose top is at or above the viewport top — the one straddling scrollTop (the last
   *  i with prefix[i] <= scrollTop). This is the natural "reading anchor" item. Linear scan (~mounted.length ≤ ~100);
   *  sub-microsecond, dominated by the surrounding DOM work, and a binary search would need a leftmost-bound variant
   *  to tolerate zero-height entries (a rebuilt ghost). Returns -1 if none (empty / everything below the fold). */
  private topVisibleIdx(): number {
    this.flushPrefix();
    const st = this.viewport.scrollTop;
    let idx = -1;
    for (let i = 0; i < this.mounted.length; i++) {
      if (this.prefix[i] <= st) idx = i; else break;
    }
    return idx;
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
    // The content origin: the oldest item's top is always prefix[0] = 0, so this is the intentional absolute write
    // (the one non-anchor write — "go to origin", not "stabilize/position relative to content").
    this.shifting = true;
    this.viewport.scrollTop = 0;
    this.shifting = false;
    this.lastScrollTop = 0;
    this.emit();
  }

  scrollToIndex(id: number, anchor: 'top' | 'center' | 'bottom' = 'center', highlight = false): void {
    if (this.destroyed) return;
    const idx = this.indexOfId(id);
    if (isDevMode()) console.log('[JUMP] scrollToIndex id=', id, 'alreadyMounted idx=', idx);
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
   * Incrementing gen invalidates in-flight loadOlder/loadNewer; appendLive is dropped while filling (SSE messages are
   * in the source cache, retrieved by getNewer when scrolling back). A centered anchor needs enough content on both
   * sides for a "true center"; fillAround grows the window to threshold (best-effort near boundaries, clamp concedes).
   */
  private async openAround(id: number, anchor: 'top' | 'center' | 'bottom', highlight: boolean): Promise<void> {
    const g = ++this.gen;
    if (isDevMode()) console.log('[JUMP] openAround start id=', id, 'gen=', g, 'vh=', this.vh, 'threshold=', this.threshold);
    this.resetWindowState();
    try {
      const batch = await this.source.init(id, this.cfg.mountItem, this.cfg.mountItem, this.initOpts);
      if (this.destroyed || g !== this.gen) { if (isDevMode()) console.log('[JUMP] bail: gen overtaken / destroyed'); return; } // overtaken by a newer jump / destroyed
      const merged = this.mergeBatch(batch);
      const key = String(id);
      const hasTarget = merged.some(it => this.itemHasId(it, id));
      if (isDevMode()) console.log('[JUMP] init batch merged=', merged.length, 'hasTarget=', hasTarget, 'ids=', merged.slice(0, 2).map(i => i.id), '..', merged.slice(-2).map(i => i.id), 'noOlder/noNewer=', this.noOlder, this.noNewer);
      if (merged.length === 0 || !hasTarget) { this.updateGhost(); this.emit(); return; } // source did not return the target
      this.absorbBoundary(merged);
      this.mountBatch(merged, 'init');
      this.measurePending();
      if (isDevMode()) console.log('[JUMP] after init mount+measure: mounted=', this.mounted.length, 'totalH=', Math.round(this.totalH()), 'sampleH=', this.mounted.slice(0, 5).map(e => Math.round(e.height)));
      // Pin the target to its anchor BEFORE the first async fill await yields to the painter.
      // resetWindowState left scrollTop=0; without this early pin the init batch paints at the window
      // top and the target only "arrives" via a visible scroll at the end (show-then-scroll glitch).
      // fillAround re-pins after every load so the target holds its anchor across the whole fill.
      {
        const initIdx = this.indexOfId(id);
        if (initIdx >= 0) this.positionMounted(initIdx, anchor);
      }
      await this.fillAround(id, anchor, g); // fill both ways to threshold/2 each (boundary exceptions) + when one side hits a boundary fill the other to threshold; re-pin after each batch
      if (this.destroyed || g !== this.gen) { if (isDevMode()) console.log('[JUMP] bail after fill: gen overtaken'); return; }
      if (isDevMode()) console.log('[JUMP] fill done: mounted=', this.mounted.length, 'range=', this.mounted[0]?.item.id, '..', this.mounted[this.mounted.length - 1]?.item.id, 'totalH=', Math.round(this.totalH()), 'noOlder/noNewer=', this.noOlder, this.noNewer);
      const idx = this.indexOfId(id);
      if (idx >= 0) {
        this.positionMounted(idx, anchor);
        if (highlight) this.flashHighlight(idx);
      } else console.error('[JUMP] openAround: target id=', id, 'not mounted after fill (idx=-1) — jump produced no view');
      this.updateGhost();
      this.emit();
    } finally {
      this.state = 'steady';
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
  private async fillAround(targetId: number, anchor: 'top' | 'center' | 'bottom', g: number): Promise<void> {
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
    if (isDevMode()) console.log('[JUMP] fill iters up/down/comp=', upIter, downIter, compIter, 'totalH=', Math.round(this.totalH()));
  }

  /** Total height of all mounted entries above targetId (= topOf(targetIdx)). If the target is not in the window, treat everything as above. */
  private aboveTarget(targetId: number): number {
    const idx = this.indexOfId(targetId);
    return idx < 0 ? this.totalH() : this.topOf(idx);
  }
  /** Total height of all mounted entries below targetId (excluding the target itself). If the target is not in the window → 0. */
  private belowTarget(targetId: number): number {
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
    if (merged.length === 0) {
      // An empty page can be the first authoritative indication that the cache is already at the
      // global floor. The current top row was created as a skeleton, so setting noOlder alone would
      // leave its spinner DOM mounted forever.
      this.noOlder = true;
      this.revealOldestGhost();
      return 0;
    }
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

  /** Positioning math for a mounted idx (shared by scrollToIndex / openAround) — now an explicit item {@link Anchor}
   *  applied via {@link applyAnchor}. offset is derived from the alignment + current vh each call (so a resize between
   *  calls is honored). `shifting` (inside applyAnchor) suppresses direction misdetection. */
  private positionMounted(idx: number, anchor: 'top' | 'center' | 'bottom'): void {
    const topOfIdx = this.topOf(idx);
    const h = this.mounted[idx].height;
    const offset = anchor === 'center' ? h / 2 - this.vh / 2 : anchor === 'bottom' ? h - this.vh : 0;
    this.applyAnchor({ mode: 'item', id: this.mounted[idx].item.id, offset, fallbackId: null });
    if (isDevMode()) console.log('[JUMP] positionMounted idx=', idx, 'id=', this.mounted[idx]?.item.id, 'topOf=', Math.round(topOfIdx), 'h=', Math.round(h), 'offset=', Math.round(offset), 'vh=', this.vh, '-> scrollTop=', Math.round(this.viewport.scrollTop));
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
    this.state = 'filling';
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

  updateItemData(id: number, patch: Partial<T>): boolean {
    const idx = this.indexOfId(id);
    if (idx < 0) return false; // not mounted — the next mount reads the patched data from IDB
    const entry = this.mounted[idx];
    const prev = idx > 0 ? this.mounted[idx - 1].item : null;
    // New item ref with patched data (entry.item is replaced wholesale). By contract the height is
    // unchanged (a status overlay / meta slot flip never alters the cell's measured height), so update()'s
    // re-render fires no onHeightChange → no reflow, no anchor compensation, no dirtyPrefix churn.
    const newItem: CbItem<T> = {
      ...entry.item,
      data: { ...(entry.item.data as object), ...(patch as object) } as unknown as T,
    };
    entry.item = newItem;
    entry.vs.update(newItem, prev);
    return true;
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
    this.state = 'destroyed';
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

  /** Single source of truth for the skeleton-vs-real decision. A slot is a skeleton iff it is the topmost item
   *  (prev === null) AND the global oldest has NOT been reached. atOldestEdge covers three cases: boundary 'oldest',
   *  'both' (a sole item spanning both edges), and the kernel's noOlder. The noOlder case is what keeps an optimistic
   *  send in an EMPTY thread real (no boundary marker, but noOlder=true → not a skeleton) — without it the sole pending
   *  bubble would render as a top spinner. When the slot is a skeleton and the consumer supplied createSkeleton, use it;
   *  otherwise fall back to createItem (legacy/no-skeleton behavior, e.g. the spec harness). */
  private createVs(item: CbItem<T>, prev: CbItem<T> | null): CbElement<T> {
    const atOldestEdge = item.boundary === 'oldest' || item.boundary === 'both' || this.noOlder;
    const skeleton = prev === null && !atOldestEdge;
    return skeleton && this.hooks.createSkeleton ? this.hooks.createSkeleton(item) : this.hooks.createItem(item, prev);
  }

  /** Create and mount one entry: createItem + DOM insert (before anchorEl / append) + pendingMeasure + subscribe to height.
   *  `animate` (default false) marks a mount that should play cb-enter after its height settles — only insertAfter and
   *  appendLive pass true; scroll-loaded history batches (init/older/newer) never animate. */
  private createEntry(item: CbItem<T>, prev: CbItem<T> | null, anchorEl?: HTMLElement | null, animate = false): Entry<T> {
    if (isDevMode()) this.mountTick++;
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
    if (isDevMode()) this.mountTick++;
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

  /** Unmount the oldest (mounted[0], DOM top). Does not compensate scrollTop (the caller trimOlder compensates inside `shifting`). */
  private unmountTop(): boolean {
    if (this.mounted.length === 0) return false;
    const e = this.mounted[0];
    e.unsub();
    if (e.el.parentNode === this.content) this.content.removeChild(e.el);
    e.vs.destroy();
    this.mounted.shift();
    if (isDevMode()) this.unmountTick++;
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
    if (isDevMode()) this.unmountTick++;
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
    if (isDevMode()) this.unmountTick++;
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
    // Invariant (dev-only — isDevMode() is stripped in AOT, so prod pays nothing): after unmounting every tracked
    // row, .msg-content must hold NO kernel-tagged ([data-cb-id]) children. A remaining one is an orphan — a row
    // mounted by a scroller whose async fetch was overtaken by destroy() but that mounted anyway. Every await-then-
    // mount path (init / openAround / loadOlder / loadNewer / runMessageSignal) re-checks `this.destroyed` after its
    // await precisely to prevent this; a missing check is how orphans are born. THROW rather than silently sweep:
    // sweeping would (a) leak the orphan host's Angular component ref + ResizeObserver (there is no handle to
    // destroy() them) and (b) mask the root cause behind a quiet warn. The sentinel (#topSentinel) and the tail cap
    // carry no data-cb-id, so they never trip this.
    if (isDevMode()) {
      const orphanCount = this.content.querySelectorAll('[data-cb-id]').length;
      if (orphanCount > 0) {
        throw new Error(`[chat-box] unmountAll invariant violated: ${orphanCount} orphaned row(s) remain in content — a scroller mounted rows after being destroyed (re-audit the post-await \`destroyed\` guard in init()/openAround/load*)`);
      }
    }
  }

  /** Sync skeleton state (pure class): skeleton = mounted[0] (oldest mounted) when "not yet at the global oldest". Compared by entry reference. */
  private updateGhost(): void {
    const target = !this.noOlder && this.mounted.length > 0 ? this.mounted[0] : null;
    if (target === this.ghostEntry) return;
    this.ghostEntry?.el.classList.remove('cb-ghost');
    target?.el.classList.add('cb-ghost');
    this.ghostEntry = target;
  }

  /** Replace the top skeleton after an empty older-page response proves it is the real oldest row. */
  private revealOldestGhost(): void {
    const ghost = this.ghostEntry;
    if (ghost) {
      ghost.el.classList.remove('cb-ghost');
      this.rebuildEntry(ghost);
      this.measurePending();
    }
    this.updateGhost();
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
   *  - Was pinned to bottom (anchor.mode === 'bottom', captured BEFORE measureVh so the at-bottom test uses the OLD vh):
   *    re-apply the bottom anchor (re-pin to the new bottom) and do NOT load/trim — the transient balance a shrink
   *    triggers is the visible jitter, and a re-pin is the only correct response.
   *  - Mid-screen: scrollTop is vh-independent (topOf(anchor)+offset), so it is unchanged in absolute px — the same
   *    line stays in view; scheduleBalance is a no-op unless the user happens to sit at an edge.
   *  Content-driven rebalances (item height changes, native scroll) still run via onElHeight + onNativeScroll. */
  private onViewportResize(): void {
    if (this.destroyed) return;
    // Immunity frame: a route-transition animation is in flight. Hold the current pin so the
    // message list does not jump under the sliding overlay; flushViewportResize runs this once on thaw.
    if (this.isFrozen()) { this.resizeDeferred = true; return; }
    const anchor = this.captureAnchor();      // BEFORE measureVh (at-bottom test uses the OLD vh + kernel totalH)
    this.measureVh();                          // apply the new vh
    if (anchor.mode === 'bottom' && this.mounted.length > 0) {
      this.applyAnchor(anchor);                // re-pin to the new bottom (new vh)
      // applyAnchor wrote scrollTop under shifting, but that guard resets synchronously — before the async scroll event
      // is dispatched. Set the one-shot flag so onNativeScroll swallows that event. This is the ONE site that needs it:
      // a shrink can pin at a bottom whose newer end is trimmed (noNewer=false), where an armed balance would loadNewer
      // and jump. (Every other pin site has noNewer=true ⇒ the follow-on balance is a harmless no-op.)
      this.suppressScrollBalance = true;
      return;
    }
    this.scheduleBalance();                    // mid-screen: scrollTop stays; re-check edges only
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
   *  `animating` is bumped when the rAF is scheduled (the move is "in flight" from this commit) and decremented exactly
   *  once by: animationend, the safety timeout, OR cancelEntryAnim cancelling the rAF / clearing enterTimer. enterRaf
   *  (rAF pending, class not added) and enterTimer (rAF fired, animation running) are mutually exclusive. */
  private enterAnim(entry: Entry<T>, cls: 'cb-enter' | 'cb-enter-above' = 'cb-enter'): void {
    if (entry.enterRaf !== undefined && entry.enterTimer === undefined) { cancelAnimationFrame(entry.enterRaf); entry.enterRaf = undefined; this.animating--; }
    this.animating++;
    entry.enterRaf = requestAnimationFrame(() => {
      entry.enterRaf = undefined;
      if (this.destroyed) { this.onAnimEnd(); return; } // torn down mid-frame → balance animating, no DOM write
      entry.el.classList.remove('cb-pending');
      entry.el.classList.add(cls);
      const finish = () => {
        if (entry.enterTimer === undefined) return;
        clearTimeout(entry.enterTimer); entry.enterTimer = undefined;
        entry.el.classList.remove(cls);
        this.onAnimEnd();
      };
      entry.enterTimer = setTimeout(finish, ANIM_SAFETY_MS); // safety if animationend is swallowed
      entry.el.addEventListener('animationend', finish, { once: true });
    });
  }

  /** balance: the scroll-driven checkpoint. Loads one batch at the edge that triggered (older at top / newer at bottom),
   *  then trims the **opposite** end (split: trim is a separate phase, invoked by the caller after the load resolves).
   *  Async because it awaits the load (+ reconcileOptimistic on the newer edge) before trimming; the RAF caller ignores
   *  the returned promise, and `animating>0` / inflight guards prevent harmful re-entry. */
  private async balance(): Promise<void> {
    if (this.destroyed || this.mounted.length === 0) return;
    if (isDevMode() && this.closeCheckpoint) return; // debug: turn off the mount checkpoint (do not trigger loadOlder/loadNewer; removed in prod AOT)
    const t0 = isDevMode() ? performance.now() : 0;
    const m0 = this.mountTick, u0 = this.unmountTick;
    const st = this.viewport.scrollTop;
    const dir = this.scrollDir(st);
    this.lastScrollTop = st;

    const total = this.totalH();
    const atTop = st < this.cfg.edge;
    const atBottom = total - this.vh - st < this.cfg.edge;

    if (atTop && dir !== 'down' && !this.noOlder) { await this.loadOlder(); this.trimNewer(); }
    else if (atBottom && dir !== 'up' && !this.noNewer) { await this.loadNewer(); await this.reconcileOptimistic(); this.trimOlder(); }

    if (isDevMode() && this.onDebug) {
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
      if (this.destroyed || merged.length === 0) {
        if (merged.length === 0) {
          this.noOlder = true;
          this.revealOldestGhost();
        }
        return;
      }
      this.absorbBoundary(merged); // phase 0: absorb boundary only after passing
      // Capture the anchor AFTER revalidate (the user's current position — they may have scrolled during the await),
      // BEFORE the prepend. The prepended batch + ghost-reveal push the anchor item down; applyAnchor follows so the
      // fold content stays put. Replaces the single compensateAbove(addedPx + rebuildDelta) with one anchor re-apply.
      const anchor = this.captureAnchor();
      const oldGhost = this.ghostEntry;
      this.mountBatch(merged, 'older'); // prepend (no internal measure)
      if (oldGhost && this.mounted.indexOf(oldGhost) > 0) {
        oldGhost.el.classList.remove('cb-ghost'); // must happen before rebuild swaps the el
        this.rebuildEntry(oldGhost);
      }
      this.measurePending(); // one unified measure: new batch + ghost reveal (`measuring` suppresses onElHeight)
      this.applyAnchor(anchor); // the prepend + ghost-reveal grew content above the fold → anchor follows (no jump)
      this.updateGhost();
    } finally {
      this.inflightOlder = false;
    }
  }

  /** Load ONE newer batch: getNewer (cursor = newerCursorId(), the newest non-transient/optimistic mounted item) +
   *  mergeItems, then a mount-dispatch. **Pure load — no trim** (split: the caller — balance / onMessageSignal — trims
   *  the opposite end after this resolves, and onMessageSignal runs reconcileOptimistic too). Never follows — explicit
   *  go-to-bottom intent is owned by {@link followToNewest} (started from scrollToBottom); a balance-triggered call
   *  (user scrolling to the bottom edge) loads one batch and leaves the viewport put. Returns the count of items MOUNTED
   *  or ABSORBED (0 = boundary / overtaken / no data / revalidate failed) — absorbed items count so a pure-absorb signal
   *  still reports progress (its optimistic still needs reconcile). */
  private async loadNewer(force = false): Promise<number> {
    if (this.inflightNewer) return 0;
    // Empty window has no real cursor. Only a FORCED (signal-triggered) pull may proceed — it falls through
    // to the init(-1) newest-page fallback below, which is how an empty thread mounts its FIRST incoming
    // message (receiver side) and how an all-optimistic window confirms its first send (sender side). An
    // unforced call (balance / followToNewest) on an empty window has nothing to do. newerCursorId() is never
    // reached on the empty path: the hasReal ternary below routes empty/all-optimistic windows to init(-1),
    // never getNewer — so the empty-mounted crash the old combined guard protected against is unreachable here.
    if (this.mounted.length === 0 && !force) return 0;
    if (!force && this.noNewer) return 0;
    this.inflightNewer = true;
    const g = this.gen;
    let batch: CbItem<T>[];
    try {
      // No real cursor exists when the window is empty (the FIRST incoming message on a brand-new thread — receiver
      // side) OR entirely optimistic/transient (the first send in an empty thread — sender side): newerCursorId()
      // would then fall back to an optimistic/transient id (or throw on empty), which getNewer cannot resolve
      // (returns []), stranding the confirmed real off-window and leaving the bubble "sending" forever / the incoming
      // message undelivered. Fetch the newest page directly via init(-1, …) — the canonical "newest N items" op —
      // which resolves from the live-cached reals. The empty-window case reaches this branch only via the forced
      // signal path (see the guard above); an unforced call bails earlier.
      const hasReal = this.mounted.some(e => !e.transient && !e.optimistic && !e.leaving && !e.resortTarget);
      batch = hasReal
        ? await this.source.getNewer(this.newerCursorId(), this.cfg.mountItem)
        : await this.source.init(-1, this.cfg.mountItem, 0, this.initOpts);
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
    // means more newer data remains (a large SSE backlog spans multiple pages) → noNewer=false so the next signal/balance
    // loads further. absorbBoundary is sticky (only ever sets true), so without this a partial backlog page left the kernel
    // falsely believing it was at the newest — stranding the remaining newer messages off-window and blocking further
    // loads (revalidateBottom is gated on !noNewer).
    this.noNewer = batch.some(it => it.boundary === 'newest' || it.boundary === 'both');

    const count0 = this.mounted.length;

    // The batch is reals only — in-flight optimistic sends are mounted separately at the newest edge via elevatePending
    // (driven by source.getPending()). Insert reals BEFORE the optimistic/transient tail block. Each real animates on
    // enter: from above (cb-enter-above) when a tail is present (cover-avoidance), else from below (cb-enter). Confirm
    // (matches an optimistic/transient) → flagged resortTarget (reconcileOptimistic removes the optimistic duplicate and
    // tags this real cb-confirmed); incoming (no match) → plain new message; already-mounted real (dup) → skip.
    const absorbed = this.mountNewerReals(this.mergeBatch(batch)); // items folded into existing albums (no new mount)

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
    // mounted delta + absorbed: an absorbed item changes the view (album grew) and may need reconcile (its optimistic is
    // still mounted), so it counts as progress — without it, a pure-absorb signal would report 0 and onMessageSignal would
    // skip reconcileOptimistic, orphaning the absorbed item's optimistic bubble.
    return (this.mounted.length - count0) + absorbed;
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
   *
   * Returns the number of items ABSORBED into existing entries (no new mount). Mounted items are observable via the
   * mounted.length delta at the caller; absorbed items are not (they fold in without a new entry), so they are reported
   * explicitly to keep loadNewer's progress count honest (a pure-absorb batch still did work).
   */
  private mountNewerReals(reals: CbItem<T>[]): number {
    if (reals.length === 0) return 0;
    // Insertion point = right after the last real entry (the cursor). When NO real is mounted — the window is entirely
    // optimistic/transient, i.e. the first confirm in an empty thread — default to 0 so the new real becomes the
    // first/oldest entry with prev=null (correct group-head flags + cb-enter-above), rather than appending it after the
    // optimistic block where its prev would be the transient it is about to replace.
    let insertIdx = 0;
    for (let i = this.mounted.length - 1; i >= 0; i--) {
      const e = this.mounted[i];
      if (!e.transient && !e.optimistic && !e.leaving && !e.resortTarget) { insertIdx = i + 1; break; }
    }
    // A trailing optimistic/transient block sits after the insert point. When it does, every new real must enter FROM
    // ABOVE (cb-enter-above): it descends into its slot from the newest-real side so it never travels DOWN through the
    // pending band (a downward cb-enter would visually cover the pending mid-animation). The tail simultaneously shoves
    // down via cb-move (onMessageSignal), the pair moving apart in one frame. Without a tail (plain incoming at the
    // bottom), cb-enter (from below) is the natural "message arrives" motion.
    const enterAbove = insertIdx < this.mounted.length;
    const absorb = this.hooks.absorbTail; // null when no hook is wired (the app supplies album/domain knowledge here)
    let absorbed = 0; // items folded into an existing entry (no new mount) — reported up so callers count them as progress
    for (const item of reals) {
      // Confirm: an in-flight optimistic/transient send whose clientMessageId matches this real. The real carries a
      // fresh server id (≠ the optimistic's clientMessageId-as-id), so the pair is matched by clientMessageId, not id.
      // No clientMessageId → a plain incoming message (no optimistic bubble to settle). An already-mounted real (dup,
      // by id — an incoming that raced with a load) is skipped.
      const confirm = this.itemFulfilledCids(item).some(c => this.indexOfClientMsgId(c) >= 0);
      if (!confirm && this.indexOfId(item.id) >= 0) continue; // already-mounted real (dup) → skip

      // Cross-batch album absorb: an item the hook folds into the running newest real — `target` = mounted[insertIdx-1]
      // (the entry this item would follow). Absorbing morphs target in place (no new bubble, insertIdx unchanged) so a
      // run of absorbable items all fold into it; the first non-absorbable item mounts normally and becomes the new
      // newest, ending the run. Self-correcting — no sticky mode. Only offered when target is a stable real.
      //
      // BOTH plain incoming AND confirms are offered. A confirm that absorbs (a self-sent image joining the running
      // album) folds its image in and — because absorbAlbumTail unions clientMessageIds onto the merged item — carries
      // its cid onto the album, so reconcileOptimistic removes the matching optimistic bubble. No new entry, no
      // resortTarget: the album is the already-sent real; the absorbed image "joining" it IS the send confirmation, so
      // the spinner→check choreography is NOT replayed (it played, or will play, on the album head). This is what lets a
      // self-sent image burst collapse into one album the same way an incoming burst does.
      if (absorb && insertIdx > 0) {
        const target = this.mounted[insertIdx - 1];
        if (target && !target.optimistic && !target.transient && !target.leaving && !target.resortTarget) {
          const merged = absorb(target.item, item);
          if (merged !== null) {
            this.measuring = true; // suppress onElHeight compensation/balance for the synchronous re-render (mirrors reconcilePending)
            target.item = merged;
            const tp = insertIdx > 1 ? this.mounted[insertIdx - 2].item : null;
            target.vs.update(merged, tp);
            const h = target.el.offsetHeight; // real height after the album grew (integer — layout.ts Math.rounds every row)
            if (h !== target.height) { target.height = h; this.dirtyPrefix = true; }
            this.measuring = false;
            absorbed++; // an absorbed item changes the view (album grew) without growing mounted[] — counted so a pure-absorb signal still reports progress (n > 0) and reconcile runs
            continue; // absorbed — no new entry; target is still the newest real (insertIdx unchanged)
          }
        }
      }

      const anchorEl = insertIdx < this.mounted.length ? this.mounted[insertIdx].el : null;
      const prev = insertIdx > 0 ? this.mounted[insertIdx - 1].item : null;
      // A confirm (matches an in-flight optimistic by clientMessageId) takes the optimistic's slot — same id, same
      // position — so it does NOT play a cb-enter: the bubble is already on screen as the optimistic; only the
      // cb-confirmed spinner→check choreography should play (reconcileOptimistic tags it). A plain incoming real (no
      // optimistic counterpart) DOES animate — enterAbove when a tail is present, else cb-enter from below. Flagged
      // resortTarget so reconcileOptimistic removes the optimistic duplicate and tags this real cb-confirmed.
      const entry = this.createEntry(item, prev, anchorEl, !confirm);
      entry.enterAbove = enterAbove;
      if (confirm) { entry.resortTarget = true; }
      this.mounted.splice(insertIdx, 0, entry);
      insertIdx++;
    }
    this.dirtyPrefix = true;
    return absorbed;
  }

  /**
   * Optimistic-confirm reconciliation: remove every in-flight optimistic whose cid is fulfilled by a mounted real, and
   * tag this batch's newly-mounted reals (resortTarget) cb-confirmed so the sent-check choreography (spinner→check→fade,
   * scoped to these "special" items via :host(.cb-confirmed)) plays on them. Album-aware: a merged/absorbed album real
   * fulfills EVERY member's cid (itemFulfilledCids), so a same-batch self-sent burst or a cross-signal absorb reconciles
   * all its members' optimistic bubbles — not just the head's.
   *
   * The slide animation is owned elsewhere, not here: the real's enter (cb-enter-above, descending from above to avoid
   * covering the tail) plays at mount in measurePending, and the remaining optimistic tail's shove (cb-move FLIP) plays
   * in onMessageSignal after this returns. This pass only does the synchronous duplicate removal + cb-confirmed tag, run
   * within the loadNewer→reconcile microtask so the momentary two-bubble state (real + the optimistic duplicate beside it)
   * is never observed — the optimistic is gone by the time the frame paints. The optimistic sits at the tail (at/below the
   * viewport), so its removal needs no above-viewport compensation (the guard is retained for odd positions). Synchronous →
   * trim's rule-4a guard never observes `resorting` true.
   */
  private async reconcileOptimistic(): Promise<void> {
    // Build the set of cids fulfilled by mounted reals (a real album fulfills EVERY member's optimistic cid — see
    // itemFulfilledCids — so an absorbed/merged album reconciles all its members, not just the head). resortTarget
    // entries are reals mounted THIS batch (the album head) that should play the spinner→check choreography; an absorbed
    // member is NOT a resortTarget (the album is the already-sent real; the image joining it is its own confirmation, so
    // the check is not replayed on the album).
    const fulfilled = new Set<string>();
    const targets: Entry<T>[] = [];
    for (const e of this.mounted) {
      if (e.transient || e.optimistic || e.leaving) continue;        // only reals fulfill an optimistic
      for (const c of this.itemFulfilledCids(e.item)) fulfilled.add(c);
      if (e.resortTarget) targets.push(e);
    }
    // An optimistic tail entry whose cid is fulfilled is a duplicate → remove it (synchronous, no cb-leave). The scan is
    // the inverse of the old target→source pairing, so it naturally covers multi-cid albums (one album fulfills many
    // optimistics) AND the single-confirm case (one cid → one optimistic).
    const toRemove: Entry<T>[] = [];
    for (const e of this.mounted) {
      if (!e.optimistic || e.leaving) continue;
      if (e.item.clientMessageId !== undefined && fulfilled.has(e.item.clientMessageId)) toRemove.push(e);
    }
    if (toRemove.length === 0 && targets.length === 0) return;
    this.resorting = true;
    try {
      // Capture once before removing the optimistic duplicates (a single synchronous batch before paint): an above-fold
      // removal shifts content up (the anchor follows, fold stays put); a tail removal while pinned re-pins to the new
      // bottom. Per-source compensateAbove + the above-fold check collapse to one anchor re-apply.
      const anchor = this.captureAnchor();
      for (const source of toRemove) {
        const i = this.mounted.indexOf(source);
        if (i < 0) continue;
        this.unmountAt(i);
      }
      // A resortTarget real is already visible at its true position — the cb-confirmed tag alone gates the
      // spinner→check→fade choreography on it. (When its source optimistic was already gone — e.g. a jump during pending
      // unmounted it — toRemove did not include it, but the tag still plays so the user sees the send confirmed.)
      for (const t of targets) {
        t.resortTarget = false;
        t.el.classList.add('cb-confirmed');
      }
      this.dirtyPrefix = true;
      this.measurePending();
      this.applyAnchor(anchor);
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
    if (!this.steady) return;
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
   * Flip an in-flight optimistic send to "sent" in place — the delivery-confirm milestone (HTTP 200 / upload done) was
   * reached. Morphs the entry to the source's fresh status:'sent' snapshot via CbElement.update (no remount) and tags
   * the element cb-confirmed so the spinner→check→fade choreography plays. Unlike reconcilePending this does NO reorder
   * and NO FLIP: a sent send stays at its tail position, so the later SSE-echo cb-move FLIP remains the only movement
   * and stays unaffected (the decoupling). Single-trigger: a no-op if the SSE echo already swapped the optimistic out
   * (no mounted match) or it already carries cb-confirmed (play once).
   *
   * Defensive prune: if the real fulfilling this cid is ALREADY mounted (the mount loaded past the pending before it
   * entered its removal flow — an invariant violation, since the SSE-echo path should have both dropped source.pending
   * and removed the optimistic), the stale optimistic is removed here and a warn is surfaced rather than morphing a
   * duplicate. See {@link indexOfFulfiller}.
   */
  confirmPending(clientMessageId: string): void {
    if (!this.steady) return;
    const e = this.mounted.find((x) => x.optimistic && !x.leaving && x.item.clientMessageId === clientMessageId);
    if (!e || e.el.classList.contains('cb-confirmed')) return; // SSE echo already swapped it out, or already confirmed → play once

    // Defensive backstop for the "mount already loaded past the pending" invariant. The real that fulfills this
    // optimistic (same clientMessageId) must be ABSENT here: the SSE-echo path that mounts it (loadNewer →
    // mountNewerReals → reconcileOptimistic) also drops the source.pending entry, so markPendingSent would have
    // returned false and confirmPending would never have been called. If a fulfilling real IS mounted anyway, the
    // invariant is violated — the optimistic duplicate never entered its removal flow while the mount raced ahead of
    // the pending's seq. Self-heal: remove the stale optimistic now (the real already owns the slot, tagged
    // cb-confirmed by reconcileOptimistic or inert), mirroring reconcileOptimistic's synchronous removal + anchor
    // re-apply so a tail removal while pinned at the bottom re-pins correctly. Surface a warn (unguarded, like the
    // '[JUMP] ... not mounted' error at openAround) so the regression is observable in prod, not just dev.
    const fulfillerIdx = this.indexOfFulfiller(clientMessageId);
    if (fulfillerIdx >= 0) {
      const real = this.mounted[fulfillerIdx];
      console.warn(
        `[chat-box] confirmPending: removed a stale optimistic (id=${e.item.id}, cid=${clientMessageId}) whose ` +
        `fulfilling real (id=${real.item.id}) is already mounted — the mount loaded past the pending before it entered ` +
        `its removal flow. Invariant violation: reconcileOptimistic should have removed it first. Please report.`,
      );
      this.resorting = true; // rule-4a: keep trim away from the synchronous removal (mirrors reconcileOptimistic)
      try {
        const anchor = this.captureAnchor();
        this.unmountAt(this.mounted.indexOf(e));
        this.dirtyPrefix = true;
        this.measurePending();
        this.applyAnchor(anchor);
      } finally {
        this.resorting = false;
      }
      this.emit();
      return;
    }

    const fresh = this.source.getPending().find((p) => p.clientMessageId === clientMessageId);
    if (!fresh) return; // source already dropped the entry — nothing to morph to
    const idx = this.mounted.indexOf(e);
    const prev = idx > 0 ? this.mounted[idx - 1].item : null;
    this.measuring = true; // suppress onElHeight compensation/balance for the synchronous re-render (mirrors reconcilePending)
    e.item = fresh;
    e.vs.update(fresh, prev); // re-render: status:'sent' renders the check + drops msg-sending (un-dims the bubble)
    e.el.classList.add('cb-confirmed'); // gates the spinner→check→fade choreography (_row-base.scss :host(.cb-confirmed))
    const h = e.el.offsetHeight; // status morph is icon/opacity-only → height is stable, but stay honest
    if (h !== e.height) { e.height = h; this.dirtyPrefix = true; }
    this.measuring = false;
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

  /** Trim the older end (top, mounted[0]). **Keep a buffer above the viewport**: the projected scrollTop after the
   *  cumulative trim (orig - cumH) minus the candidate h must stay > edge. The anchor is captured once (the topmost-
   *  visible item — the buffer guarantees it is never mounted[0]); after the loop, applyAnchor sets scrollTop =
   *  topOf(anchor)+offset, and topOf(anchor) has dropped by exactly cumH, so scrollTop = orig - cumH (equivalent to the
   *  old per-iteration `scrollTop -= h`, and to re-pinning when the viewport was at the bottom). Trimming resets noOlder. */
  private trimOlder(): void {
    if (this.resorting) return; // rule 4a: never trim during a resort
    const anchor = this.captureAnchor();
    let trimmed = false;
    let cumH = 0;
    while (this.mounted.length > 1) {
      const first = this.mounted[0];
      // Never trim transient/optimistic/leaving, and rule 4b: never trim the global-newest real item (defensive — the
      // newest normally sits at the tail, but the guard holds regardless of position).
      if (first.transient || first.optimistic || first.leaving || first.item.boundary === 'newest' || first.item.boundary === 'both') break;
      const h = first.height;
      if (this.totalH() - h > this.threshold && (this.viewport.scrollTop - cumH) - h > this.cfg.edge) {
        this.unmountTop();
        cumH += h;
        trimmed = true;
      } else break;
    }
    if (trimmed) {
      this.noOlder = false;
      this.applyAnchor(anchor); // follows the trimmed-above delta; no-op-ish shift that keeps the fold put
    }
  }

  // ---------- Height / viewport stabilization ----------

  /** An element reports its real height — either the synchronous read in {@link measurePending}, OR the async
   *  ResizeObserver firing later (image/data/font settle, post-render growth). Capture an {@link Anchor} BEFORE the
   *  height mutation (so totalH/topOf reflect the pre-change layout), apply the cache, then re-apply the anchor.
   *  The anchor alone encodes BOTH old policies with no branching:
   *   - an item anchor auto-follows above-viewport growth: offset is stable, the grown item pushed topOf(anchor) down,
   *     and applyAnchor moves scrollTop to match (the visible content stays put) — the old compensateAbove(h-old);
   *   - a bottom anchor (captured because the viewport was pinned) re-pins to the new bottom — the old wasAtBottom
   *     re-pin that kept a late-settling tail item from sinking below the fold (the retry + new-message pin failure).
   *
   *  captureAnchor reads the kernel height model (totalH), NOT content.scrollHeight: by the time the RO fires, the DOM
   *  already reflects the new height, so content.scrollHeight would read POST-change and the at-bottom test would
   *  falsely fail for a tail growth. totalH() here still holds the OLD entry height (the mutation is below). The first
   *  report inside mount/measure/shifting is cache-only (reentrancy guard — measurePending does the unified settle). */
  private onElHeight(entry: Entry<T>, h: number): void {
    if (this.destroyed) return;
    const old = entry.height;
    if (old === h) return;
    const stabilize = !this.shifting && !this.mounting && !this.measuring;
    const anchor = stabilize ? this.captureAnchor() : null; // BEFORE the mutation (pre-change layout)
    entry.height = h;
    this.dirtyPrefix = true;
    if (anchor) {
      this.applyAnchor(anchor);
      this.scheduleBalance();
    }
  }

  /** Whether an item represents the given msgId — matches {@link CbItem.id} OR any member in {@link CbItem.ids}
   *  (so a jump to a non-head album member still resolves to its album item). */
  private itemHasId(item: CbItem<T>, id: number): boolean {
    if (item.id === id) return true;
    const ids = item.ids;
    return ids !== undefined && ids.includes(id);
  }

  /** Current index of the entry representing id (onElHeight/scrollToIndex/openAround). O(n), low frequency. */
  private indexOfId(id: number): number {
    return this.mounted.findIndex(e => this.itemHasId(e.item, id));
  }

  /** Index of the in-flight optimistic/transient entry carrying the given clientMessageId — the reconcile key
   *  that pairs an optimistic send with its confirmed real (the real gets a fresh server id, so the pair cannot
   *  be matched by id). Scans transient/optimistic entries only; -1 if none / cid absent. */
  private indexOfClientMsgId(cid: string | undefined): number {
    if (cid === undefined) return -1;
    return this.mounted.findIndex(e => (e.transient || e.optimistic) && e.item.clientMessageId === cid);
  }

  /** All clientMessageIds this real item fulfills — the head's singular clientMessageId, PLUS every album member's cid
   *  (clientMessageIds, set by the merge/absorb hooks when they combine same-creator IMAGE reals). Used to pair
   *  confirmed reals with their in-flight optimistic bubbles: an album confirms EVERY member's optimistic, not just the
   *  head's. Empty for a plain incoming/history message (no optimistic to reconcile). */
  private itemFulfilledCids(item: CbItem<T>): string[] {
    if (item.clientMessageIds) return item.clientMessageIds;
    return item.clientMessageId !== undefined ? [item.clientMessageId] : [];
  }

  /** Index of the mounted REAL entry that fulfills the given clientMessageId — the confirm counterpart of an in-flight
   *  optimistic (the real — or its album, via {@link itemFulfilledCids} — that carries this cid). -1 if none. Mirrors the
   *  fulfiller half of {@link reconcileOptimistic}'s scan so the defensive prune in {@link confirmPending} shares the exact
   *  same album-aware pairing logic: a self-sent image absorbed into a running album fulfills its cid just as a standalone
   *  real does. Scans reals only (skips transient/optimistic/leaving) — an optimistic never fulfills another optimistic. */
  private indexOfFulfiller(cid: string): number {
    return this.mounted.findIndex((e) => {
      if (e.transient || e.optimistic || e.leaving) return false;
      return this.itemFulfilledCids(e.item).includes(cid);
    });
  }

  /** Oldest mounted item id that is a real source member — skips transient inserts (insertAfter), optimistic sends
   *  (in-flight pending, not in the reloadable sequence), and leaving entries (removeItem mid-exit), whose ids are not
   *  stable source cursors. Used by loadOlder so such an entry at mounted[0] doesn't make getOlder return [] and falsely
   *  lock noOlder. Callers guarantee mounted is non-empty. */
  private olderCursorId(): number {
    for (const e of this.mounted) if (!e.transient && !e.optimistic && !e.leaving) return e.item.id;
    return this.mounted[0].item.id; // unreachable in practice (the insert/remove target is always a real neighbor)
  }

  /** Newest mounted item id that is a real source member — skips transient/optimistic inserts and leaving entries.
   *  Symmetric to olderCursorId. */
  private newerCursorId(): number {
    for (let i = this.mounted.length - 1; i >= 0; i--) {
      const e = this.mounted[i];
      if (!e.transient && !e.optimistic && !e.leaving) {
        return e.item.ids?.at(-1) ?? e.item.id;
      }
    }
    const tail = this.mounted[this.mounted.length - 1].item;
    return tail.ids?.at(-1) ?? tail.id;
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
      if (this.mounted.indexOf(entry) < 0) continue; // already unmounted (guards leftovers after trim)
      const h = entry.el.offsetHeight;
      if (isDevMode() && h === 0) zeros++;
      this.onElHeight(entry, h); // `measuring` suppresses compensation + balance (loadOlder does the unified compensation)
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
    if (isDevMode() && (zeros > 0 || this.filling)) console.log('[JUMP] measure n=', entries.length, 'zeroH=', zeros, 'contentScrollH=', this.content.scrollHeight);
    // Integer-height verification: totalH (Σ item offsetHeight + tailCap) vs content.scrollHeight. With the integer
    // line-height contract in _row-base.scss these must agree up to a CONSTANT sentinel offset — d must NOT grow with
    // the mounted count. Before that contract d drifted ~+11px over 63 items (summing rounded per-item heights vs one
    // rounded total). If d grows here, a row is rendering at a fractional height — re-audit its line-height.
    //
    // Tolerated as a regression guard, not a runtime input: the kernel deliberately keeps totalH() and scrollHeight
    // independent (see isAtBottom/captureAnchor), and every control-flow comparison already carries a tolerance that
    // dwarfs the residual seam (≥1 px; balance uses cfg.edge=1000). VS_DRIFT_TOLERANCE_PX is the maximum constant
    // offset expected under the integer contract; a larger |d| means a row broke that contract.
    //
    // The comparison is ONLY valid when content overflows the viewport (sh > vh): the shell sets min-height:100% +
    // justify-content:flex-end on content (.pg-content / .msg-content), so an under-viewport thread pegs scrollHeight
    // at the viewport height (the flex filler above the bottom-pinned messages) while totalH correctly tracks only
    // real content. Comparing them below the viewport is a guaranteed false positive — the filler is viewport-sized,
    // not per-row drift (sub-pixel accumulation could never reach hundreds of px at n=2). The regression this guard
    // catches only manifests at scale, i.e. once content overflows and min-height saturates, so the gate loses no real
    // signal.
    if (isDevMode()) {
      const sh = this.content.scrollHeight;
      if (sh > this.vh) { // min-height saturated → scrollHeight reflects true content height (valid independent check)
        const t = this.totalH();
        const d = Math.round(t - sh);
        if (Math.abs(d) > VS_DRIFT_TOLERANCE_PX) {
          console.warn(`[vs.measure] height model drifted ${d}px past tolerance (n=${entries.length} mount=${this.mounted.length} totalH=${Math.round(t)} sh=${sh} vh=${this.vh}) — a row is likely rendering at a fractional line-height; re-audit _row-base.scss`);
        }
      }
    }
  }

  private emit(): void { this.onScroll?.(this.getInfo()); }
}
