/**
 * ChatBoxScroller — array-index + source-driven virtual list with manual scrollTop compensation.
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
 * [Manual compensation] Mounting upward (prepend older) + above-viewport height change → scrollTop += delta;
 *   trimming the top → scrollTop -= delta; below-viewport changes are not compensated. Browser overflow anchoring
 *   stays disabled so this kernel is the sole viewport owner.
 *
 * [Async handling] getOlder/getNewer are async; on resolve we [revalidate] (still at that edge + direction not
 *   reversed + boundary not hit), otherwise we only update the cache and do not mount (zero visual jump; the next
 *   balance mounts from cache when the user scrolls back). Compensation uses the [measured] height at resolve time,
 *   not a snapshot from request time.
 *
 * Development diagnostics are guarded by Angular's public `isDevMode()` API.
 */
import { OffsetScrollMotion } from './offset-scroll-motion';
import {
  captureScrollLayout,
  compensateScrollLayout,
  visualOffsetOf,
  type ScrollLayoutSnapshot,
} from './scroll-layout';
import { CbLayoutScheduler } from './cb-layout-scheduler';
import { CbGapCoordinator } from './cb-gap-coordinator';
import {
  Observable,
  Subscriber,
  Subscription,
  concatMap,
  defer,
  map,
  of,
  tap,
} from 'rxjs';
import { isDevMode } from '@angular/core';
import { applyJumpHighlight } from './jump-highlight';
import { MeasuredRegionView } from './measured-region-view';
import { selectHistoryEdges } from './history-edge-slots';

import { EdgeDemandState } from './edge-demand-state';
import {
  alignedItemOffset,
  distanceToViewportCenter,
  type ViewportAnchor,
} from './viewport-anchor';

import {
  type CbDemandResult,
  type CbSource,
  type CbSourceWindowRequest,
} from './cb-source';

export interface CbItem<T = unknown> {
  /** Real data id (the msgId from the source). Only a source cursor + read by createItem for data; **takes no part in position arithmetic** (kernel position uses the array index). */
  id: number;
  data: T;
  /** Display-only interval (left exclusive, right inclusive), never a stable message anchor. */
  displayInterval?: { left: number; right: number };
  /** Window-local presentation boundary before this row. Keeps neighbor/date context,
   * but prevents compact sender grouping across an omitted-history interval. Never persisted. */
  groupingBreakBefore?: boolean;
  /** Boundary marker (assigned by the source): 'oldest' = global oldest, 'newest' = global newest, 'both' = a sole
   *  item that is BOTH the global oldest and newest (a single-message thread, or a length-1 init batch spanning the
   *  whole sequence — the field is single-valued, so without 'both' the source's items[0]='oldest' / items[last]='newest'
   *  would collide on the same item and lose the oldest marker, leaving noOlder unset → permanent top ghost). */
  boundary?: 'oldest' | 'newest' | 'both';
  /**
   * All member msgIds an aggregated item (e.g. album) represents — populated by the mergeItems hook
   * when it merges several msgs into one item (the first member equals {@link id}). Single (non-merged)
   * items leave this undefined. Purpose: id resolution for jump/positioning (smoothScrollToMessage, indexOfId)
   * must land on the album item when the target is any album member — otherwise jumping to a non-head
   * image's msgId fails to find it (item.id only carries the head) and the viewport ends up empty
   * (jump-to-id bug). Read-only in the kernel; the source returns raw msgs and never sets this.
   */
  ids?: number[];
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
 * Height-changing updates are committed by the kernel and measured synchronously.
 *
 * There is no estimateHeight(): the kernel never guesses a height. createEntry seeds height=0 and
 * measurePending() reads the real el.offsetHeight synchronously (batched, before any positioning),
 * so the height is always the true rendered value — never an estimate that has to be corrected.
 */
export interface CbElement<T = unknown> {
  readonly el: HTMLElement;
  /** Independently measured trailing presentation, excluded from message anchors and arrival height. */
  measureTailHeight?(): number;
  /** Re-render an ALREADY-mounted element in place with new data/prev (no remount). Mirrors `createItem(item, prev)`:
   *  the hook recomputes presentation (data + any prev-derived grouping/date flags) and applies it to the same DOM
   *  node + component instance. Used by reconcilePending to morph a pending send's status (sending→failed) and to
   *  re-group after a reorder, without the destroy+recreate that would break a FLIP move animation. */
  update(item: CbItem<T>, prev: CbItem<T> | null): void;
  /** Paint-only grouping refresh when the newer neighbor changes. Implementations must keep offsetHeight stable. */
  updateNext?(next: CbItem<T> | null): void;
  /** Stop owned activity without destroying the DOM; final disposal is separate.
   * Optional while finite/test renderers migrate to the item lifecycle. */
  /** Stop all row-owned business activity synchronously before disposal. Does not destroy Angular components or DOM. */
  predestory(): void;
  destroy(): void;
}

/** createItem: wraps an item into a CbElement. prev = the older neighbor (index-1 within mounted), used to compute grouping (head/continuation); null if none. */
export interface CbHooks<T = unknown> {
  messageSeqs?: (item: CbItem<T>) => readonly number[];
  /** Update attached tail presentation before measurement, never from a scroll notification.
   * Return changed hosts so their combined heights settle in the same transaction. */
  updateTailPresentation?: (newest: CbItem<T> | null) => readonly HTMLElement[];
  createItem: (
    item: CbItem<T>,
    prev: CbItem<T> | null,
  ) => CbElement<T>;
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
  /** Fixed first-window batch size. Default 100. */
  initBatch?: number;
  /** Follow newly arriving messages only while at the bottom. Existing-item height changes and keyboard/composer
   *  or viewport geometry preserve an existing composer attachment independently of this policy. */
  followBottom?: boolean;
}

export interface CommittedTombEvent {
  threadId: number;
  deletions: Array<{ seq: number; type: 'USER_RETRACTION' | 'MODERATION_REMOVAL' }>;
}

export interface CbOptions<T> {
  committedTombs$?: Observable<CommittedTombEvent>;
  onMountedTomb?: (fact: CommittedTombEvent['deletions'][number]) => void;
  viewport: HTMLElement;
  content: HTMLElement;
  hooks: CbHooks<T>;
  /** Host-owned source replacement for navigation outside the mounted window. */
  onWindowJump?: (request: CbWindowNavigation) => Promise<boolean>;
  config?: CbConfig;
  onScroll?: (info: CbScrollInfo) => void;
  /** Runs after a rendered body is inserted and registered in the mounted window.
   * Deferred until the synchronous mount batch completes; discarded if the body
   * is replaced/unmounted first. Hosts may attach body-scoped observers here. */
  onItemMounted?: (item: CbItem<T>, element: CbElement<T>) => void;
  /** Paint-only viewport work coalesced into the kernel's scroll RAF before onScroll is emitted. */
  onViewportPaint?: () => void;
  /** Fires on the rising edge from not-fully-visible to fully visible. Visibility uses the kernel's measured
   *  prefix/height model, so consumers do not need a second DOM observer. */
  onFullyVisibleEnter?: (
    entries: readonly { item: CbItem<T>; el: HTMLElement }[],
  ) => void;
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

/**
 * Read-only geometry for one mounted item, expressed in the scroll viewport's local coordinate space.
 * The kernel is the sole owner of item heights and prefix positions; paint-only consumers must use this
 * model instead of measuring every mounted DOM row again during scroll.
 */
export interface CbMountedGeometry<T = unknown> {
  readonly index: number;
  readonly item: CbItem<T>;
  readonly el: HTMLElement;
  readonly top: number;
  readonly bottom: number;
  readonly height: number;
}

export interface CbViewportGeometry {
  readonly scrollTop: number;
  readonly viewportHeight: number;
  /** Empty space above a short, bottom-aligned message stack. */
  readonly contentAlignmentOffset: number;
}

/** Explicit window presentation intent. Message IDs are coordinates, never mode flags. */
export type CbWindowRequest<T> =
  | { kind: 'cached' }
  | { kind: 'start' }
  | CbWindowNavigation;

/** Only explicit navigation can ask a window owner to replace its content. */
export type CbWindowNavigation =
  | { kind: 'latest' }
  | {
      kind: 'message';
      messageId: number;
      anchor: 'top' | 'center' | 'bottom';
      highlight?: boolean;
    };

/**
 * Scroll anchor — the stable "where should scrollTop be" intent that survives across content mutations. scrollTop is
 * DERIVED from it by {@link ChatBoxScroller.applyAnchor}, never nudged imperatively at each mutation site.
 *
 *  - `bottom`: follow the global content bottom (the newest). Used for live arrivals / sends while pinned.
 *  - `item`: keep `id` at a fixed `offset` from the viewport top (offset = scrollTop - topOf(id), signed). Any
 *    above-viewport growth shifts topOf(id) and applyAnchor follows automatically — this is the manual equivalent of
 *    the browser's overflow-anchor.
 *
 * `fallbackId` (the entry right below the anchor at capture) rescues the case where the anchored entry itself is
 * removed (removeItem / reconcileOptimistic): it shifts into the anchor's old slot, so topOf(fallback)+offset is the
 * same preserved position. Null at the tail / when there is no successor.
 */
export type Anchor = ViewportAnchor;

/** Public kernel capabilities. */
export interface ScrollerApi<T = unknown> {
  /** Load and position an explicitly selected window. */
  openWindow(request: CbWindowRequest<T>): Promise<void>;
  retryOlder?(): void;
  retryNewer?(): void;
  /** Load an arrival only if the pre-arrival latest real message is still mounted. */
  notifyNewerAvailable?(previousLatestSeq?: number): void;
  /** Pin to the global newest edge; navigate through the window owner only when newest history is not mounted. */
  goToLatest(): Promise<boolean>;
  /** Resolve a stable message/member ID, loading its window if needed. Reveal the
   * nearest edge; a visible message stays put unless overscroll is positive.
   * Returns whether this request still owns a mounted target after navigation. */
  smoothScrollToMessage(id: number, overscroll?: number, highlight?: boolean): Promise<boolean>;
  setFollowBottom(enabled: boolean): void;
  scrollToTop(): void;
  /** Insert a single item immediately after the mounted entry representing afterId. No-op (returns false) if afterId
   *  is not currently mounted or a re-seed is in progress. Does NOT trigger balance (no checkpoint load, no trim) —
   *  Compensates scrollTop for any growth above the viewport so the viewport stays put. By default the inserted item
   *  is transient (viewport-only, not registered with the source: a
   *  debug FAKE insert). Pass {optimistic:true} for a pending send — the entry is marked optimistic (in source.pending,
   *  returned by getNewer; skipped by cursors; protected from trim as part of the atomic optimistic block). */
  insertAfter(
    afterId: number,
    item: CbItem<T>,
    opts?: { optimistic?: boolean },
  ): boolean;
  /** Remove mounted entries synchronously by id or album-member id.
   * Returns the number of removed rows (0 = none mounted). */
  removeItem(ids: number | number[]): number;
  /** Transform one mounted item (album-aware) while preserving the viewport anchor. Returning null uses
   * immediate removal; returning an item rebuilds/re-measures the row in place.
   * An array atomically splits the mounted entry into ordered source-coordinate rows. */
  mutateItem(
    id: number,
    mutate: (item: CbItem<T>) => CbItem<T> | CbItem<T>[] | null,
  ): boolean;
  getInfo(): CbScrollInfo;
  /** Snapshot the currently fully visible message ids, including album members.
   * A read tracker can use this after resuming even when no new enter event fires. */
  getFullyVisibleIds(): number[];
  /** Visit mounted items in DOM order using the kernel's cached integer heights and prefix sums. */
  visitMountedGeometry(
    visitor: (geometry: CbMountedGeometry<T>) => boolean | void,
  ): CbViewportGeometry;
  /** Resolve one mounted item (album-member aware) without reading layout from the DOM. */
  getMountedGeometry(id: number): CbMountedGeometry<T> | null;
  refresh(): void;
  /** Re-render one mounted item's data IN PLACE (no remount, no height re-measure) — for a data-only
   *  change whose presentation never alters the cell's measured height (e.g. a mediaStatus flip: the
   *  status overlay + meta slot are height-neutral). Album-aware via {@link indexOfId}: any member id
   *  resolves to the album item. Morphs through `CbElement.update` (the same path reconcilePending uses
   *  for a status morph) with the patched data and the unchanged prev neighbor; because the height is
   *  unchanged, no reflow and no anchor correction. Returns false when the item is not
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
  followBottom: true,
};

const ARRIVAL_FOLLOW_WINDOW_MS = 120;
const ARRIVAL_FOLLOW_MAX_VIEWPORT_RATIO = 0.7;

/** Maximum tolerated drift (px) between the kernel height model (totalH = Σ integer offsetHeight + tailCap) and the
 *  live content.scrollHeight, asserted only in the dev-mode integer-height check. Under the integer line-height contract
 *  (every height-contributing value is integer px) the two agree up to a single rounding seam, so 1 px is the
 *  expected envelope. A larger |d| means a row is rendering at a fractional height — the warning re-points at _row-base.
 *  This is a dev-only regression guard; runtime comparisons carry their own tolerances (≥1 px; balance uses cfg.edge). */
const VS_DRIFT_TOLERANCE_PX = 1;

/** Mounted identity, renderer, and committed geometry. Rebuild replaces the renderer and remeasures its layout. */
interface Entry<T> {
  item: CbItem<T>;
  el: HTMLElement;
  vs: CbElement<T>;
  height: number;
  tailHeight: number;
  /** True for items inserted via insertAfter (not registered with the source). Such ids are invalid getOlder/getNewer
   *  cursors, so cursor derivation (olderCursorId/newerCursorId) skips them — prevents a transient at either end from
   *  making a load return [] and falsely locking noOlder/noNewer. */
  transient: boolean;
  /** True for an in-flight pending send (insertAfter {optimistic:true}): registered with source.pending, returned by
   *  getNewer when the real batch is short. Skipped by cursor derivation (its id is not in the reloadable sequence)
   *  and protected from trim — the optimistic block at the tail is atomic (all loaded by once, removed by once; only
   *  reconcileOptimistic removes a member, never trim). Mutually exclusive with `transient` (FAKE inserts). */
  optimistic: boolean;
}

/** Infrastructure readiness is independent of a bound window's fill phase.
 * Window subscriptions own asynchronous delivery and are released before source destruction. */
export type KernelState =
  | 'ready'
  | 'filling'
  | 'steady'
  | 'unavailable'
  | 'destroyed';

export class ChatBoxScroller<T = unknown> implements ScrollerApi<T> {
  private readonly viewport: HTMLElement;
  private readonly content: HTMLElement;
  private readonly hooks: CbHooks<T>;
  private boundSource: CbSource<T> | null = null;
  private get source(): CbSource<T> {
    if (!this.boundSource) throw new Error('chat-box kernel is not bound');
    return this.boundSource;
  }
  private entrySeqs(item: CbItem<T>): readonly number[] {
    return item.displayInterval ? [] : this.hooks.messageSeqs?.(item) ?? item.ids ?? [item.id];
  }

  private readonly intervalSubscriptions = new Map<Entry<T>, Subscription>();

  private readonly cfg: Required<CbConfig>;
  private bindingAbort: AbortController | null = null;
  private windowContext: { chatId?: number; signal?: AbortSignal } = {};
  private readonly onScroll?: (info: CbScrollInfo) => void;
  private readonly onViewportPaint?: () => void;
  private readonly onFullyVisibleEnter?: CbOptions<T>['onFullyVisibleEnter'];
  private readonly onItemMounted?: CbOptions<T>['onItemMounted'];
  private fullyVisibleIds = new Set<number>();
  private readonly isFrozen: () => boolean;
  private layoutSettleTimer?: ReturnType<typeof setTimeout>;
  private readonly committedTombs$?: Observable<CommittedTombEvent>;
  private readonly onMountedTomb?: CbOptions<T>['onMountedTomb'];
  private tombSubscription?: Subscription;
  // Retain facts for this binding: an already-read history result can mount later.
  private readonly tombFacts = new Map<number, CommittedTombEvent['deletions'][number]>();
  private tombApplied = new WeakMap<Entry<T>, Set<number>>();

  private consumeMountedTombs(): void {
    // Mount and measurement are synchronous. A subscribed newer edge can be
    // parked waiting for future arrivals, so subscription presence is not a
    // loading flag. Retained facts also cover results that have not mounted yet.
    if (!this.steady || !this.onMountedTomb) return;
    for (const [seq, fact] of this.tombFacts) {
      const entry = this.mounted.find((row) => this.entrySeqs(row.item).includes(seq));
      if (!entry || this.tombApplied.get(entry)?.has(seq)) continue;
      const applied = this.tombApplied.get(entry) ?? new Set<number>();
      applied.add(seq);
      this.tombApplied.set(entry, applied);
      this.onMountedTomb(fact);
      // A deletion may split an album or replace the entry itself.
      for (const row of this.mounted) {
        if (!this.entrySeqs(row.item).includes(seq)) continue;
        const done = this.tombApplied.get(row) ?? new Set<number>();
        done.add(seq);
        this.tombApplied.set(row, done);
      }
    }
  }
  private viewportWidth = 0;
  private committedLayout: ScrollLayoutSnapshot | null = null;
  private cachedLayoutRows: ScrollLayoutSnapshot['rows'] | null = null;
  private resizeLayout: ScrollLayoutSnapshot | null = null;
  private resizeAttached = false;

  /** External CSS reflow: wait for quiet, then refresh geometry without moving the reader. */
  scheduleLayoutRemeasure(): void {
    if (this.inactive) return;
    if (!this.resizeLayout) {
      this.resizeAttached = this.isFollowingBottom();
      const current = this.snapshotLayout();
      const committed = this.committedLayout;
      const domMax = Math.max(0, this.content.scrollHeight - this.vh);
      this.resizeLayout = committed && committed.scrollTop > domMax &&
        Math.abs(current.scrollTop - domMax) < 1 ? committed : current;
    }
    this.cancelArrivalWindow();
    this.cancelMotion();
    this.settlePresentation(this.visualOffset);
    this.scheduler?.enterResizing();
    if (this.layoutSettleTimer !== undefined) clearTimeout(this.layoutSettleTimer);
    this.layoutSettleTimer = setTimeout(() => {
      this.flushLayoutRemeasure();
      this.emit();
      this.onViewportStateChanged();
    }, 200);
  }

  private flushLayoutRemeasure(): void {
    if (this.layoutSettleTimer === undefined) return;
    clearTimeout(this.layoutSettleTimer);
    this.layoutSettleTimer = undefined;
    const before = this.resizeLayout ?? this.snapshotLayout();
    this.resizeLayout = null;
    const attached = this.resizeAttached;
    this.resizeAttached = false;
    for (const entry of this.mounted) {
      entry.height = entry.el.offsetHeight;
      entry.tailHeight = entry.vs.measureTailHeight?.() ?? 0;
    }
    this.dirtyPrefix = true;
    const offset = attached ? this.clampOffset(Infinity)
      : compensateScrollLayout(before, this.snapshotLayout()) ?? visualOffsetOf(before);
    this.settlePresentation(offset);
    this.scheduler?.leaveResizing();
  }

  /** Ordered mounted entries: index 0 = oldest (DOM top) → last = newest (DOM bottom). The index is a window-local index. */
  private mounted: Entry<T>[] = [];
  /** Prefix sum: prefix[i] = Σheight[0..i-1] (prefix[0] = 0, prefix[n] = totalH). Recomputed by flushPrefix when dirtyPrefix. */
  private prefix: number[] = [0];
  private dirtyPrefix = true;

  private noOlder = false;
  private noNewer = false;
  private arrivalDemand = false;
  private bottomReserveView?: MeasuredRegionView;
  private bottomReserveH = 0;
  private readonly olderDemand = new EdgeDemandState<T>();
  private readonly newerDemand = new EdgeDemandState<T>();
  private initializationSubscription?: Subscription;
  private finishInitialization?: () => void;

  /** Kernel lifecycle (category A); see {@link KernelState}. */
  private state: KernelState = 'ready';
  get lifecycleState(): KernelState {
    return this.state;
  }
  /** Derived phase questions (read-only views over {@link state} — single source of truth, cannot drift). Getters, not
   *  flags, so each access is a FRESH read: the many post-`await` `destroyed` checks stay correct even though TypeScript
   *  (unsoundly) narrows a mutable member across `await`. */
  private get steady(): boolean {
    return this.state === 'steady';
  }
  private get filling(): boolean {
    return this.state === 'filling';
  }
  private get inactive(): boolean {
    return this.state === 'destroyed' || this.state === 'ready';
  }
  /** Debug switch: turn off the mount checkpoint (balance will not trigger loadOlder/loadNewer). Guarded by isDevMode() inside balance → removed in prod AOT. Default false (checkpoint loads normally). */
  closeCheckpoint = false;

  /** Queue of entries awaiting real-height measurement (stores entry refs; the callback reads the current index via indexOf). */
  private pendingMeasure: Entry<T>[] = [];

  private vh = 0;
  private shifting = false; // suppresses scroll-direction misdetection + onElHeight compensation caused by programmatic scrollTop writes
  /** Set after a viewport-resize reflow re-pins to bottom. The programmatic positionAtBottom write fires an async scroll
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
  private scheduler: CbLayoutScheduler | null = null;
  private readonly gapCoordinator = new CbGapCoordinator<CbItem<T>>();
  private readonly gapEntries = new Map<string, Entry<T>>();
  private pendingOlderDelivery: CbDemandResult<T> | null = null;
  private pendingNewerDelivery: CbDemandResult<T> | null = null;
  private readonly animator: OffsetScrollMotion;
  private translateY = 0;
  /** Logical compensation, independent of the browser's subpixel scroll rounding. */
  private outOfBounds = false;
  private lockedScrollTop = 0;
  private savedOverflowY: string | null = null;
  private savedScrollbarGutter: string | null = null;
  private followIntent = false;
  private motionRequest: {
    id: number;
    clientMessageId?: string;
    anchor: 'top' | 'bottom';
    overscroll: number;
    direction: number;
    pinned: boolean;
    offsetFromTop?: number;
  } | null = null;
  private navigationGeneration = 0;
  private navigationChatId: number | undefined;
  private motionGeneration = 0;
  private readonly layoutMotion = new WeakMap<ScrollLayoutSnapshot, {
    generation: number;
    arrivalTimer: ReturnType<typeof setTimeout> | null;
    acceptedOffset: number;
  }>();
  private programmaticScrollTop: number | null = null;
  private arrivalWindowTimer: ReturnType<typeof setTimeout> | null = null;
  private arrivalWindowWasPinned = false;
  private arrivalWindowAddedH = 0;
  private arrivalWindowBaseline: ScrollLayoutSnapshot | null = null;
  private arrivalWindowAcceptedOffset = 0;
  // Oversized bursts reveal a small fixed peek, never the full rejected growth.
  private readonly arrivalOversizeReveal = 20;
  private lastScrollTop = 0;
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
    if (this.vvRafId || this.inactive) return;
    this.vvRafId = requestAnimationFrame(() => {
      this.vvRafId = 0;
      this.onViewportResize();
    });
  };

  private readonly onWindowJump?: CbOptions<T>['onWindowJump'];

  constructor(opts: CbOptions<T>) {
    this.viewport = opts.viewport;
    this.onWindowJump = opts.onWindowJump;
    this.content = opts.content;
    this.animator = new OffsetScrollMotion({
      getOffset: () => this.visualOffset,
      setOffset: (offset) => {
        this.setVisualOffset(offset);
        this.onViewportPaint?.();
        this.emit();
        this.onViewportStateChanged();
      },
      onFinish: () => {
        this.motionRequest = null;
      },
    });
    this.hooks = opts.hooks;
    this.onScroll = opts.onScroll;
    this.onViewportPaint = opts.onViewportPaint;
    this.onFullyVisibleEnter = opts.onFullyVisibleEnter;
    this.onItemMounted = opts.onItemMounted;
    this.committedTombs$ = opts.committedTombs$;
    this.onMountedTomb = opts.onMountedTomb;
    this.isFrozen = opts.isFrozen ?? (() => false);
    this.cfg = { ...DEFAULTS, ...opts.config };
    this.viewportObs = new ResizeObserver(() => this.onViewportResize());
  }

  /** Attach fresh binding resources without rebuilding viewport infrastructure. */
  bind(source: CbSource<T>, windowContext: { chatId?: number } = {}): void {
    if (this.state === 'destroyed')
      throw new Error('chat-box kernel is disposed');
    if (this.state !== 'ready')
      throw new Error('unbind the current chat-box source first');
    if (this.navigationChatId !== windowContext.chatId) this.navigationGeneration++;
    this.navigationChatId = windowContext.chatId;
    this.boundSource = source;
    this.bindingAbort = new AbortController();
    this.windowContext = { ...windowContext, signal: this.bindingAbort.signal };
    this.scheduler = new CbLayoutScheduler(() => this.balance());
    this.state = 'steady';
    this.tombSubscription = this.committedTombs$?.subscribe((event) => {
      if (event.threadId !== this.windowContext.chatId) return;
      for (const fact of event.deletions) {
        this.tombFacts.set(fact.seq, fact);
        this.gapCoordinator.recordTomb(fact.seq);
      }
      this.consumeMountedTombs();
    });
    this.measureVh();
    this.viewportWidth = this.viewport.clientWidth;
    this.viewportObs.observe(this.viewport);
    this.viewport.addEventListener('scroll', this.onNativeScroll, {
      passive: true,
    });
    this.viewport.addEventListener('wheel', this.onScrollIntent, { passive: false });
    this.viewport.addEventListener('touchmove', this.onScrollIntent, { passive: false });
    this.viewport.addEventListener('pointerdown', this.onScrollIntent, { passive: false });
    this.viewport.addEventListener('keydown', this.onScrollIntent);
    // visualViewport: the definitive keyboard-show/hide signal (see onVisualViewportChange). The viewport element's
    // own ResizeObserver fires only when its border-box changes, which on mobile keyboards it often does not (or does
    // so unreliably); this listener guarantees the re-pin runs on every visual-viewport change regardless.
    window.visualViewport?.addEventListener(
      'resize',
      this.onVisualViewportChange,
    );
    window.visualViewport?.addEventListener(
      'scroll',
      this.onVisualViewportChange,
    );
    this.bottomReserveView = new MeasuredRegionView('cb-bottom-reserve', () =>
      this.onRegionResize(),
    );
    this.bottomReserveH = this.bottomReserveView.mount(this.content);
  }

  private get threshold(): number {
    return Math.max(this.vh + this.cfg.vhExtra, this.cfg.thresholdFloor);
  }

  openWindow(request: CbWindowRequest<T>): Promise<void> {
    if (this.inactive) return Promise.resolve();
    this.cancelInitialization();
    this.cancelOlderDemand();
    this.cancelNewerDemand();
    this.state = 'filling';
    return new Promise<void>((resolve, reject) => {
      this.finishInitialization = resolve;
      const subscriber = new Subscriber<void>({
        next: () => {
          // Finish ownership before invoking host callbacks, which may open a
          // successor window synchronously.
          subscriber.unsubscribe();
          this.finishInitialization = undefined;
          resolve();
          if (this.state === 'unavailable') return;
          this.state = 'steady';
          this.consumeMountedTombs();
          this.onViewportStateChanged();
        },
        error: (error: unknown) => {
          this.state = 'unavailable';
          this.finishInitialization = undefined;
          reject(error);
        },
        complete: () => {
          this.finishInitialization = undefined;
          resolve();
        },
      });
      this.initializationSubscription = subscriber;
      let work: Observable<void>;
      switch (request.kind) {
        case 'cached':
          work = this.mountCachedWindow();
          break;
        case 'start':
          work = this.openHistoryStart();
          break;
        case 'message':
          work = this.openMessageWindow(request);
          break;
        case 'latest':
          work = this.openLatestWindow();
          break;
      }
      work.subscribe(subscriber);
    });
  }

  /** Local absence is not evidence that server history ends in either direction. */
  private mountCachedWindow(): Observable<void> {
    return this.windowItems({ kind: 'cached', count: this.cfg.initBatch }).pipe(
      tap((batch) => {
        this.resetWindowState();
        const merged = this.mergeBatch(batch);
        this.absorbBoundary(merged);
        this.mountBatch(merged, 'init');
        this.measurePending();
        this.positionAtBottom();
      }),
      map(() => undefined),
    );
  }

  /** The coordinate origin is a forward query, not a fictitious target message. */
  private openHistoryStart(): Observable<void> {
    return this.windowItems({ kind: 'start', count: this.cfg.initBatch }).pipe(
      tap((batch) => {
        this.resetWindowState();
        const merged = this.mergeBatch(batch);
        this.absorbBoundary(merged);
        this.mountBatch(merged, 'init');
        this.measurePending();
        this.noOlder = true;
        if (merged.length === 0) this.noNewer = true;
        this.viewport.scrollTop = 0;
      }),
      map(() => undefined),
    );
  }

  private openLatestWindow(): Observable<void> {
    return this.windowItems({ kind: 'latest', count: this.cfg.initBatch }).pipe(
      concatMap((batch) => {
        const merged = this.mergeBatch(batch);
        if (merged.length === 0) {
          this.noOlder = true;
          this.noNewer = true;
          this.positionAtBottom();
          return of(undefined);
        }
        this.absorbBoundary(merged);
        this.mountBatch(merged, 'init');
        this.positionAtBottom();
        return of(undefined);
      }),
      tap(() => {
        this.measurePending();
        this.positionAtBottom();
      }),
    );
  }

  private cancelInitialization(): void {
    this.initializationSubscription?.unsubscribe();
    this.initializationSubscription = undefined;
    const finish = this.finishInitialization;
    this.finishInitialization = undefined;
    finish?.();
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
  insertAfter(
    afterId: number,
    item: CbItem<T>,
    opts?: { optimistic?: boolean },
  ): boolean {
    if (!this.steady) return false;
    // Empty window: there is no anchor to insert "after", so the item becomes the sole entry (prev=null). This is the
    // first-message-in-an-empty-thread path — afterId is irrelevant there (and typically '' / the optimistic's own id,
    // since tailAnchorId() is empty when nothing is mounted).
    if (this.mounted.length === 0) {
      const layout = this.captureLayoutChange();
      const entry = this.createEntry(item, null, null, null);
      if (opts?.optimistic) entry.optimistic = true;
      else entry.transient = true;
      this.mounted.push(entry);
      this.dirtyPrefix = true;
      this.measurePending();
      this.finishLayoutChange(layout);
      return true;
    }
    const idx = this.indexOfId(afterId);
    if (idx < 0) return false; // not mounted → neglect the insert request
    // Capture the anchor BEFORE the insert: an insert above the topmost-visible item pushes it down, and applyAnchor
    // follows (the fold content stays put); an insert at/below the fold leaves the anchor's topOf unchanged → no shift.
    // This replaces the two per-delta compensateAbove checks (new item + successor rebuild) with one anchor re-apply.
    const layout = this.captureLayoutChange();
    const target = this.mounted[idx];
    const successor = this.mounted[idx + 1] ?? null;
    const anchorEl = successor ? successor.el : null;

    // New entry: prev = target item (older neighbor). DOM lands between target and successor (createEntry inserts
    // before anchorEl; no successor → append). Reveal immediately after measuring the real height.
    const entry = this.createEntry(
      item,
      target.item,
      successor?.item ?? null,
      anchorEl,
    );
    if (opts?.optimistic)
      entry.optimistic = true; // pending send: in source.pending, returned by getNewer, atomic
    else entry.transient = true; // FAKE debug insert: viewport-only, never in the source
    this.mounted.splice(idx + 1, 0, entry);
    target.vs.updateNext?.(item);
    if (successor) this.rebuildEntry(successor); // prev changed → recompute group-head/date (height reset, re-measured below)

    this.dirtyPrefix = true;
    this.measurePending(); // `measuring` suppresses onElHeight → unified applyAnchor below
    this.finishLayoutChange(layout);
    return true;
  }

  /** Remove identities synchronously; album member ids resolve to their owning row. */
  removeItem(ids: number | number[]): number {
    if (!this.steady) return 0;
    const list = Array.isArray(ids) ? ids : [ids];
    const targets: Entry<T>[] = [];
    for (const id of list) {
      const idx = this.indexOfId(id); // album-aware (itemHasId → whole album item)
      if (idx < 0) continue;
      const e = this.mounted[idx];
      if (!targets.includes(e)) targets.push(e);
    }
    const binding = this.bindingAbort;
    if (targets.length && this.isFollowingBottom()) this.followIntent = true;
    const errors: unknown[] = [];
    let removed = 0;
    for (const entry of targets) {
      if (this.bindingAbort !== binding || this.inactive) break;
      const index = this.mounted.indexOf(entry);
      if (index < 0) continue;
      const before = this.snapshotLayout();
      try {
        this.unmountAt(index);
      } catch (error) {
        errors.push(error);
      }
      removed++;
      // Cleanup may synchronously replace the binding. Never reposition its successor.
      if (this.bindingAbort === binding && !this.inactive) this.restoreLayout(before);
    }
    if (removed && this.bindingAbort === binding && !this.inactive) this.emit();
    if (errors.length) throw new AggregateError(errors, 'Chat item removal failed');
    return removed;
  }

  mutateItem(
    id: number,
    mutate: (item: CbItem<T>) => CbItem<T> | CbItem<T>[] | null,
  ): boolean {
    // A mounted view can finish an asynchronous correction during initial fill.
    // It owns no loading policy: mutate only if its entry is still mounted.
    if (this.inactive) return false;
    const idx = this.indexOfId(id);
    if (idx < 0) return false;
    const entry = this.mounted[idx];
    const layout = this.captureLayoutChange();
    const next = mutate(entry.item);
    if (next === null) return this.removeItem(id) > 0;
    const replacements = Array.isArray(next) ? next : [next];
    if (!replacements.length) return this.removeItem(id) > 0;
    this.rebuildEntry(entry, replacements[0]);
    const successor = this.mounted[idx + 1];
    for (let offset = 1; offset < replacements.length; offset++) {
      const replacement = this.createEntry(
        replacements[offset],
        replacements[offset - 1],
        replacements[offset + 1] ?? successor?.item ?? null,
        successor?.el ?? null,
      );
      this.mounted.splice(idx + offset, 0, replacement);
    }
    this.mounted[idx - 1]?.vs.updateNext?.(entry.item);
    entry.vs.updateNext?.(replacements[1] ?? successor?.item ?? null);
    if (successor) this.rebuildEntry(successor);
    this.dirtyPrefix = true;
    this.finishLayoutChange(layout);
    this.emit();
    return true;
  }

  setFollowBottom(enabled: boolean): void {
    this.cfg.followBottom = enabled;
    if (!enabled) {
      this.followIntent = false;
      this.cancelArrivalWindow();
    }
  }

  async goToLatest(): Promise<boolean> {
    if (this.inactive || !this.steady) return false;
    const generation = ++this.navigationGeneration;
    const chatId = this.windowContext.chatId;
    if (!this.noNewer) {
      if (!this.onWindowJump) return false;
      const opened = await this.onWindowJump({ kind: 'latest' });
      if (!opened || this.inactive || generation !== this.navigationGeneration ||
          chatId !== this.windowContext.chatId || !this.noNewer) return false;
    }
    this.measurePending();
    this.cancelArrivalWindow();
    this.followAcceptedBottom();
    this.onViewportStateChanged();
    return true;
  }

  /** Position at the measured content bottom after settling any deferred geometry. */
  private positionAtBottom(): void {
    this.flushLayoutRemeasure();
    this.applyAnchor({ mode: 'bottom' });
  }

  private cancelArrivalWindow(): void {
    if (this.arrivalWindowTimer !== null) clearTimeout(this.arrivalWindowTimer);
    this.arrivalWindowTimer = null;
    this.arrivalWindowWasPinned = false;
    this.arrivalWindowAddedH = 0;
    this.arrivalWindowBaseline = null;
  }

  private scheduleArrivalWindow(
    wasPinned: boolean,
    addedHeight: number,
    baseline: ScrollLayoutSnapshot,
  ): void {
    if (!wasPinned || addedHeight <= 0) return;
    this.followIntent = true;
    if (this.arrivalWindowTimer === null) {
      this.arrivalWindowWasPinned = wasPinned;
      this.arrivalWindowAddedH = 0;
      this.arrivalWindowBaseline = baseline;
      const preserved = compensateScrollLayout(baseline, this.snapshotLayout());
      this.arrivalWindowAcceptedOffset = (baseline.targetOffset ?? visualOffsetOf(baseline)) +
        (preserved === null ? 0 : preserved - visualOffsetOf(baseline));
      const binding = this.bindingAbort;
      this.arrivalWindowTimer = setTimeout(() => {
        if (binding !== this.bindingAbort || this.inactive) return;
        this.settleArrivalWindow();
      }, ARRIVAL_FOLLOW_WINDOW_MS);
    }
    this.arrivalWindowAddedH += Math.max(0, addedHeight);
  }

  private settleArrivalWindow(): void {
    const baseline = this.arrivalWindowBaseline;
    const addedH = this.arrivalWindowAddedH;
    const accepted = this.arrivalWindowAcceptedOffset;
    const pinned = this.arrivalWindowWasPinned;
    this.cancelArrivalWindow();
    if (!pinned || !baseline || this.inactive) return;
    if (addedH <= baseline.viewportHeight * ARRIVAL_FOLLOW_MAX_VIEWPORT_RATIO) {
      this.followAcceptedBottom();
    } else {
      // Retarget, rather than cancel: an already approved flight keeps its velocity.
      this.motionRequest = null;
      this.moveToOffset(this.clampOffset(accepted + this.arrivalOversizeReveal));
    }
  }

  private get visualOffset(): number {
    return this.viewport.scrollTop - this.translateY;
  }

  private clampOffset(offset: number): number {
    return Math.max(0, Math.min(offset, Math.max(0, this.totalH() - this.vh)));
  }

  /** Only physical input is locked during compensation; layout/demand keep running. */
  private setVisualOffset(offset: number): void {
    const top = this.clampOffset(offset);
    this.outOfBounds = Math.abs(top - offset) >= 0.001;
    this.setScrollTopProgrammatic(top);
    this.lockedScrollTop = this.viewport.scrollTop;
    this.translateY = this.lockedScrollTop - offset;
    this.content.style.transform = Math.abs(this.translateY) < 0.001
      ? '' : `translateY(${this.translateY}px)`;
    if (this.outOfBounds) {
      if (this.savedOverflowY === null) {
        this.savedOverflowY = this.viewport.style.overflowY;
        this.savedScrollbarGutter = this.viewport.style.scrollbarGutter;
        const style = getComputedStyle(this.viewport);
        const borders = (parseFloat(style.borderLeftWidth) || 0) +
          (parseFloat(style.borderRightWidth) || 0);
        // Preserve an existing classic scrollbar, but never introduce a new
        // gutter for a short stack or an overlay-scrollbar host.
        if (this.viewport.offsetWidth - this.viewport.clientWidth - borders > 0) {
          this.viewport.style.scrollbarGutter = 'stable';
        }
      }
      this.viewport.style.overflowY = 'hidden';
    } else {
      this.releaseInputLock();
    }
  }

  private releaseInputLock(): void {
    if (this.savedOverflowY !== null) {
      this.viewport.style.overflowY = this.savedOverflowY;
      this.viewport.style.scrollbarGutter = this.savedScrollbarGutter ?? '';
      this.savedOverflowY = null;
      this.savedScrollbarGutter = null;
    }
  }

  /** Release presentation without relying on DOM clamping (hidden hosts read back zero). */
  private releasePresentation(): void {
    this.translateY = 0;
    this.outOfBounds = false;
    this.lockedScrollTop = 0;
    this.content.style.transform = '';
    this.releaseInputLock();
  }

  /** Resizes end motion at the browser-representable position, without compensation. */
  private settlePresentation(offset: number): void {
    this.releasePresentation();
    this.setScrollTopProgrammatic(this.clampOffset(offset));
  }

  private moveToOffset(offset: number): void {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      this.animator.snap(offset);
    } else {
      this.animator.setTarget(offset);
    }
  }

  private cancelMotion(): void {
    this.motionGeneration++;
    this.animator.cancel();
    this.motionRequest = null;
    // A legal fractional coordinate only needs paint interpolation while owned.
    // Hand input back at the DOM's rounded position, never with a stranded transform.
    if (!this.outOfBounds) this.releasePresentation();
  }

  private snapshotLayout(): ScrollLayoutSnapshot {
    const alignment = Math.max(0, this.vh - this.totalH());
    const previousRows = this.cachedLayoutRows;
    const unchanged = previousRows?.length === this.mounted.length && this.mounted.every((entry, index) => {
      const row = previousRows[index];
      const ids = entry.item.displayInterval ? [] : entry.item.ids ?? [entry.item.id];
      return row.top === alignment + this.topOf(index) && row.height === entry.height &&
        row.tailHeight === entry.tailHeight && row.ids.length === ids.length &&
        row.ids.every((id, member) => id === ids[member]);
    });
    if (!unchanged) {
      // Freeze only scalar geometry, never renderer/Entry objects. Reuse this
      // exact row array throughout a flight until committed geometry changes.
      this.cachedLayoutRows = captureScrollLayout({
        rows: this.mounted.map((entry, index) => ({
          ids: entry.item.displayInterval ? [] : entry.item.ids ?? [entry.item.id],
          top: alignment + this.topOf(index),
          height: entry.height,
          tailHeight: entry.tailHeight,
        })),
        viewportHeight: this.vh, scrollTop: 0, translateY: 0, totalHeight: this.totalH(),
      }).rows;
    }
    const snapshot: ScrollLayoutSnapshot = Object.freeze({
      rows: this.cachedLayoutRows!,
      viewportHeight: this.vh,
      scrollTop: this.viewport.scrollTop,
      translateY: this.translateY,
      totalHeight: this.totalH(),
      targetOffset: this.animator.isRunning ? this.animator.targetOffset ?? undefined : undefined,
    });
    this.layoutMotion.set(snapshot, {
      generation: this.motionGeneration,
      arrivalTimer: this.arrivalWindowTimer,
      acceptedOffset: this.arrivalWindowAcceptedOffset,
    });
    return snapshot;
  }

  private restoreLayout(before: ScrollLayoutSnapshot, targetDelta = 0): boolean {
    const offset = compensateScrollLayout(before, this.snapshotLayout());
    if (offset === null) {
      const fallback = this.followIntent || this.motionRequest?.pinned
        ? this.clampOffset(Infinity)
        : this.clampOffset(before.targetOffset ?? visualOffsetOf(before));
      this.cancelArrivalWindow();
      this.cancelMotion();
      this.setVisualOffset(fallback);
      return false;
    }
    const delta = offset - visualOffsetOf(before);
    this.setVisualOffset(offset);
    const motion = this.layoutMotion.get(before);
    // Nested renderer teardown may already have restored a sub-transaction.
    // Derive the destination from the outer snapshot exactly once, unless a
    // callback explicitly replaced/cancelled the request in the meantime.
    if (motion?.generation === this.motionGeneration && before.targetOffset !== undefined && this.animator.isRunning) {
      this.animator.setTarget(before.targetOffset + delta + targetDelta);
    } else if (!motion || motion.generation === this.motionGeneration) {
      this.animator.rebase(delta + targetDelta);
    }
    if (this.arrivalWindowTimer !== null) {
      if (motion?.arrivalTimer === this.arrivalWindowTimer) {
        this.arrivalWindowAcceptedOffset = motion.acceptedOffset + delta + targetDelta;
      } else this.arrivalWindowAcceptedOffset += delta + targetDelta;
    }
    this.resolveMotionTarget();
    if (this.animator.isRunning) {
      const target = this.animator.targetOffset;
      if (target !== null) this.animator.setTarget(this.clampOffset(target));
    } else if (this.outOfBounds) {
      this.moveToOffset(this.clampOffset(offset));
    }
    return true;
  }

  private setScrollTopProgrammatic(top: number): void {
    this.shifting = true;
    try {
      const before = this.viewport.scrollTop;
      this.viewport.scrollTop = top;
      if (this.viewport.scrollTop !== before)
        this.programmaticScrollTop = this.viewport.scrollTop;
    } finally {
      this.shifting = false;
    }
  }

  /** Capture an approved bottom destination; later unapproved growth cannot chase it. */
  private followAcceptedBottom(): void {
    this.motionGeneration++;
    const entry = [...this.mounted].reverse().find(row => !row.item.displayInterval);
    this.followIntent = true;
    this.motionRequest = entry ? {
      id: entry.item.ids?.at(-1) ?? entry.item.id,
      clientMessageId: entry.item.clientMessageId,
      anchor: 'bottom', overscroll: 0, direction: 1, pinned: true,
    } : null;
    this.moveToOffset(this.clampOffset(Infinity));
  }

  private startMessageMotion(id: number, overscroll: number): boolean {
    if (!Number.isFinite(overscroll)) return false;
    const index = this.indexOfId(id);
    if (index < 0) return false;
    this.motionGeneration++;
    const entry = this.mounted[index];
    const top = Math.max(0, this.vh - this.totalH()) + this.topOf(index);
    const height = this.messageHeight(entry);
    const current = this.visualOffset;
    const direction = top + height / 2 < current + this.vh / 2 ? -1 : 1;
    this.followIntent = false;
    this.motionRequest = {
      id, clientMessageId: entry.item.clientMessageId,
      anchor: Math.abs(top - current) <= Math.abs(top + height - this.vh - current) ? 'top' : 'bottom',
      overscroll: Math.max(0, overscroll), direction, pinned: false,
    };
    // A visible target is a no-op, including when it replaces an older request.
    if (overscroll <= 0 && top >= current && top + height <= current + this.vh) {
      this.cancelMotion();
      // Visibility does not make an out-of-range visual coordinate legal.
      if (this.outOfBounds) this.moveToOffset(this.clampOffset(current));
      return true;
    }
    if (top >= current && top + height <= current + this.vh) {
      this.motionRequest.offsetFromTop = current - top;
    }
    this.resolveMotionTarget();
    return true;
  }

  private resolveMotionTarget(): void {
    const request = this.motionRequest;
    if (!request || request.pinned) return;
    let index = this.indexOfId(request.id);
    if (index < 0 && request.clientMessageId) {
      index = this.mounted.findIndex(entry => this.itemFulfilledCids(entry.item).includes(request.clientMessageId!));
      if (index >= 0) request.id = this.mounted[index].item.id;
    }
    if (index < 0) {
      this.cancelMotion();
      this.moveToOffset(this.clampOffset(this.visualOffset));
      return;
    }
    const entry = this.mounted[index];
    const top = Math.max(0, this.vh - this.totalH()) + this.topOf(index);
    const height = this.messageHeight(entry);
    const aligned = request.offsetFromTop !== undefined ? top + request.offsetFromTop
      : request.anchor === 'top' ? top : top + height - this.vh;
    this.moveToOffset(this.clampOffset(aligned + request.direction * request.overscroll));
  }

  /**
   * Preserve the existing attachment to the composer boundary across geometry changes. The tail reserve maps
   * that boundary to the scroll-content bottom; away from it, preserve the visible message instead.
   * Capture before updating the cached geometry.
   *
   * The at-bottom test uses the KERNEL height model (totalH) inline, NOT isAtBottom()/content.scrollHeight: when
   * called from onElHeight the DOM already reflects the new height (a real ResizeObserver fires post-layout; the mock
   * updates the height map before the cb), so content.scrollHeight is the POST-change value and would falsely read
   * not-at-bottom for a tail growth. totalH() here still holds entry's OLD height (the mutation is below) → the true
   * pre-change bottom. (For the other stabilization sites, capture runs before the mutation when DOM ≡ kernel model,
   * so the two bases agree.)
   *
   * Geometry stabilization does not consult followBottom. Viewport/tail-reserve resizing and late-settling item
   * heights preserve the existing attachment; following newly inserted messages is owned by the arrival path.
   *
   * Rejects the bottom anchor while heights are unsettled (pendingMeasure > 0): a just-created/rebuilt entry has
   * height 0, which would make totalH() artificially low and the at-bottom test falsely true.
   */
  private captureComposerAnchor(): Anchor {
    if (
      this.steady &&
      this.pendingMeasure.length === 0 &&
      this.viewport.scrollTop + this.vh >= this.totalH() - 1
    )
      return { mode: 'bottom' };
    return this.captureAnchor();
  }

  private isFollowingBottom(): boolean {
    return this.cfg.followBottom && this.pendingMeasure.length === 0 &&
      (this.followIntent ||
        (this.arrivalWindowTimer !== null && this.arrivalWindowWasPinned) ||
        ((this.noNewer || this.arrivalDemand) &&
          this.visualOffset + this.vh >= this.totalH() - 1));
  }

  /** Capture before renderer mutation; growth excludes attached presentation. */
  private captureLayoutChange() {
    this.flushLayoutRemeasure();
    return {
      snapshot: this.snapshotLayout(),
      attached: this.isFollowingBottom(),
      heights: new Map(this.mounted.map(entry => [entry, this.messageHeight(entry)])),
      totals: new Map(this.mounted.map(entry => [entry, entry.height])),
    };
  }

  /** Refresh attached presentation in place; never rebuild or re-render the message body. */
  refreshTailPresentation(): void {
    if (this.inactive) return;
    const before = this.captureLayoutChange();
    this.finishLayoutChange(before);
    this.emit();
    this.onViewportStateChanged();
  }

  private finishLayoutChange(before: ReturnType<ChatBoxScroller<T>['captureLayoutChange']>): void {
    this.measurePending();
    let growth = 0;
    let tailDelta = 0;
    for (const entry of this.mounted) {
      const prevMsgH = before.heights.get(entry) ?? 0;
      const prevTotalH = before.totals.get(entry) ?? prevMsgH;
      const prevTailH = Math.max(0, prevTotalH - prevMsgH);
      growth += Math.max(0, this.messageHeight(entry) - prevMsgH);
      tailDelta += entry.tailHeight - prevTailH;
    }
    if (before.totals.size === this.mounted.length &&
        this.mounted.every(entry => before.totals.get(entry) === entry.height)) return;
    const survived = this.restoreLayout(before.snapshot);
    if (!survived) return;
    if (growth > 0) this.scheduleArrivalWindow(before.attached, growth, before.snapshot);
    else if (tailDelta !== 0 && before.attached && this.arrivalWindowTimer === null) {
      this.followAcceptedBottom();
    }
  }

  private messageHeight(entry: Entry<T>): number {
    return Math.max(0, entry.height - entry.tailHeight);
  }

  /** Preserve the visible message across content mutations; new-message following is a separate decision. */
  private captureAnchor(): Anchor {
    let idx = this.topVisibleIdx();
    if (idx >= 0 && !this.entrySeqs(this.mounted[idx].item).length) {
      const newer = this.mounted.findIndex((entry, index) => index > idx && this.entrySeqs(entry.item).length > 0);
      if (newer >= 0) idx = newer;
      else while (idx >= 0 && !this.entrySeqs(this.mounted[idx].item).length) idx--;
    }
    if (idx < 0) return { mode: 'offset', offset: this.viewport.scrollTop };
    return {
      mode: 'item',
      id: this.mounted[idx].item.id,
      offset: this.visualOffset - this.topOf(idx),
      fallbackId: this.mounted.slice(idx + 1).find((entry) => this.entrySeqs(entry.item).length > 0)?.item.id ?? null,
    };
  }

  /**
   * The ONE place `scrollTop` is written for stabilization/positioning. Derives it from the anchor:
   *  - `bottom` ⇒ content.scrollHeight - vh (live DOM, independent of prefix staleness).
   *  - `item`  ⇒ topOf(id) + offset (prefix[]). If the anchored id was removed, fall back to fallbackId (the successor
   *    that shifted into its slot) with the same offset; if that is gone too, leave scrollTop unchanged.
   * Clamps to the measured scroll range. Guarded against the destroyed state.
   *
   * Initial explicit positioning also runs while `filling`. Ordinary edge demand starts only after the
   * complete first-batch transaction. Measurement uses its own guard to avoid intermediate stabilization.
   *
   * Does NOT set the suppressScrollBalance one-shot: every pin/follow site that routes through here has noNewer=true
   * demand flow is single-flight, so the post-write scroll event can safely re-check the region. The ONE site that pins
   * with noNewer=false
   * — onViewportResize — keeps its own manual suppress set (a shrink at a trimmed bottom would otherwise loadNewer
   * and jump). The resize pin's own scroll event consumes that flag; suppressing every anchor write here could
   * instead swallow the next region check after a user scroll.
   */
  private applyAnchor(a: Anchor, previousOffset = this.visualOffset): void {
    if (this.inactive) return;
    let target: number;
    if (a.mode === 'bottom') {
      target = this.content.scrollHeight - this.vh;
    } else if (a.mode === 'offset') {
      target = a.offset;
    } else {
      let idx = this.indexOfId(a.id);
      if (idx < 0 && a.fallbackId != null) idx = this.indexOfId(a.fallbackId);
      target =
        idx >= 0
          ? this.topOf(idx) +
            a.offset
          : this.viewport.scrollTop;
    }
    this.setVisualOffset(this.clampOffset(target));
    const delta = this.visualOffset - previousOffset;
    this.animator.rebase(delta);
    if (this.arrivalWindowTimer !== null) this.arrivalWindowAcceptedOffset += delta;
    this.resolveMotionTarget();
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
      if (this.prefix[i] <= st) idx = i;
      else break;
    }
    return idx;
  }

  scrollToTop(): void {
    if (this.inactive) return;
    this.navigationGeneration++;
    this.followIntent = false;
    this.cancelArrivalWindow();
    this.cancelMotion();
    this.setVisualOffset(0);
    this.lastScrollTop = 0;
    this.emit();
  }

  async smoothScrollToMessage(id: number, overscroll = 0, highlight = false): Promise<boolean> {
    if (!Number.isFinite(overscroll)) throw new RangeError('Overscroll must be finite');
    if (this.inactive) return false;
    const generation = ++this.navigationGeneration;
    const chatId = this.windowContext.chatId;
    this.cancelArrivalWindow();
    if (this.indexOfId(id) < 0) {
      if (!this.onWindowJump) return false;
      // The host can rebind this kernel to the requested window. Only that
      // same-conversation successor may finish this request after the await.
      const opened = await this.onWindowJump({ kind: 'message', messageId: id,
        anchor: 'center', highlight });
      if (!opened || this.inactive || generation !== this.navigationGeneration ||
          chatId !== this.windowContext.chatId) return false;
    }
    const started = this.startMessageMotion(id, overscroll);
    if (started && highlight) this.flashHighlight(this.indexOfId(id), id);
    return started;
  }

  /** Mount and explicitly position one batch; ordinary edge demand owns subsequent pages. */
  private openMessageWindow(
    request: Extract<CbWindowRequest<T>, { kind: 'message' }>,
  ): Observable<void> {
    const id = request.messageId;
    const anchor = request.anchor;
    return this.windowItems({
      kind: 'around',
      messageId: id,
      olderCount: this.cfg.mountItem,
      newerCount: this.cfg.mountItem,
    }).pipe(
      concatMap((batch) => {
        const merged = this.mergeBatch(batch);
        this.resetWindowState();
        this.absorbBoundary(merged);
        this.mountBatch(merged, 'init');
        this.measurePending();
        const targetIndex = this.indexOfId(id);
        if (targetIndex < 0) {
          console.warn('[chat-box] skipping unavailable target positioning', {
            messageId: id,
          });
          return of(undefined);
        }
        this.positionMounted(targetIndex, anchor);
        if (request.highlight) this.flashHighlight(targetIndex, id);
        return of(undefined);
      }),
    );
  }

  /** Position the initial window's target using its explicit alignment and current viewport height.
   * `shifting` inside applyAnchor suppresses direction misdetection. */
  private positionMounted(
    idx: number,
    anchor: 'top' | 'center' | 'bottom',
  ): void {
    const h = this.mounted[idx].height;
    const offset = alignedItemOffset(h, this.vh, anchor);
    this.applyAnchor({
      mode: 'item',
      id: this.mounted[idx].item.id,
      offset,
      fallbackId: null,
    });
  }

  /** Clear all mounted rows and load/boundary state before initializing the new window. */
  private resetWindowState(): void {
    this.cancelArrivalWindow();
    this.cancelMotion();
    this.setVisualOffset(0);
    this.programmaticScrollTop = null;
    this.arrivalDemand = false;
    this.scheduler?.cancelPending();
    this.gapCoordinator.clear();
    this.gapEntries.clear();
    this.pendingOlderDelivery = null;
    this.pendingNewerDelivery = null;
    this.unmountAll();
    this.noOlder = false;
    this.noNewer = false;
    this.cancelOlderDemand();
    this.cancelNewerDemand();
    this.olderDemand.error = null;
    this.newerDemand.error = null;
    this.lastScrollTop = 0;
    this.state = 'filling';
    this.shifting = true;
    this.viewport.scrollTop = 0; // content is empty, reset to zero
    this.shifting = false;
  }

  /** Add a one-shot highlight flash to the target entry (animationend removes the class; a reflow guarantees the animation restarts on repeated jumps). */
  private flashHighlight(idx: number, targetId?: number): void {
    const el = this.mounted[idx]?.el;
    if (!el) return;
    applyJumpHighlight(el, targetId);
  }

  getInfo(): CbScrollInfo {
    return {
      scrollTop: Math.round(this.viewport.scrollTop),
      scrollHeight: Math.round(this.content.scrollHeight),
      viewportHeight: this.vh,
      oldestId: this.mounted.find((entry) => this.entrySeqs(entry.item).length > 0)?.item.id ?? null,
      newestId: [...this.mounted].reverse().find((entry) => this.entrySeqs(entry.item).length > 0)?.item.id ?? null,
      mounted: this.mounted.length,
      atTop: this.mounted.length > 0 && this.viewport.scrollTop <= 0,
      atBottom: this.mounted.length > 0 && this.isAtBottom(),
      noOlder: this.noOlder,
      noNewer: this.noNewer,
    };
  }

  visitMountedGeometry(
    visitor: (geometry: CbMountedGeometry<T>) => boolean | void,
  ): CbViewportGeometry {
    this.flushPrefix();
    const scrollTop = this.visualOffset;
    const contentAlignmentOffset = Math.max(0, this.vh - this.totalH());
    for (let index = 0; index < this.mounted.length; index += 1) {
      const entry = this.mounted[index];
      const top =
        contentAlignmentOffset + (this.prefix[index] ?? 0) - scrollTop;
      if (
        visitor({
          index,
          item: entry.item,
          el: entry.el,
          top,
          bottom: top + entry.height,
          height: entry.height,
        }) === false
      )
        break;
    }
    return {
      scrollTop,
      viewportHeight: this.vh,
      contentAlignmentOffset,
    };
  }

  getMountedGeometry(id: number): CbMountedGeometry<T> | null {
    const index = this.indexOfId(id);
    if (index < 0) return null;
    this.flushPrefix();
    const entry = this.mounted[index];
    const top =
      Math.max(0, this.vh - this.totalH()) +
      (this.prefix[index] ?? 0) -
      this.visualOffset;
    return {
      index,
      item: entry.item,
      el: entry.el,
      top,
      bottom: top + entry.height,
      height: entry.height,
    };
  }

  refresh(): void {
    this.measureVh();
    this.scheduler?.cancelPending();
    this.balance();
  }

  updateItemData(id: number, patch: Partial<T>): boolean {
    const idx = this.indexOfId(id);
    if (idx < 0) return false; // not mounted — the next mount reads the patched data from IDB
    const entry = this.mounted[idx];
    const prev = idx > 0 ? this.mounted[idx - 1].item : null;
    // New item ref with patched data (entry.item is replaced wholesale). By contract the height is
    // unchanged (a status overlay / meta slot flip never alters the cell's measured height), so update()'s
    // Height-neutral update: no measurement, anchor correction, or prefix invalidation.
    const newItem: CbItem<T> = {
      ...entry.item,
      data: {
        ...(entry.item.data as object),
        ...(patch as object),
      } as unknown as T,
    };
    entry.item = newItem;
    entry.vs.update(newItem, prev);
    return true;
  }

  flushViewportResize(): void {
    // Apply a resize that was deferred during an immunity frame. Re-check isFrozen so a thaw that
    // races with a re-freeze (back-to-back transitions) does not prematurely flush.
    if (this.resizeDeferred && !this.inactive && !this.isFrozen()) {
      this.resizeDeferred = false;
      this.onViewportResize();
    }
  }

  /** Release a conversation while retaining reusable kernel infrastructure. */
  unbind(): void {
    this.tombSubscription?.unsubscribe();
    this.tombSubscription = undefined;
    this.tombFacts.clear();
    this.tombApplied = new WeakMap();
    if (this.layoutSettleTimer !== undefined) clearTimeout(this.layoutSettleTimer);
    this.layoutSettleTimer = undefined;
    this.cancelArrivalWindow();
    this.cancelMotion();
    this.releasePresentation();
    this.programmaticScrollTop = null;
    if (this.inactive) return;
    this.followIntent = false;
    this.committedLayout = null;
    this.cachedLayoutRows = null;
    this.resizeLayout = null;
    this.resizeAttached = false;
    this.state = 'ready';
    this.cancelInitialization();
    this.cancelOlderDemand();
    this.cancelNewerDemand();
    // Source abort handlers may synchronously complete/error their Observables.
    // End every result subscription before invoking those handlers.
    this.bindingAbort?.abort();
    this.bindingAbort = null;
    this.scheduler?.dispose();
    this.scheduler = null;
    this.gapCoordinator.clear();
    this.gapEntries.clear();
    this.pendingOlderDelivery = null;
    this.pendingNewerDelivery = null;
    cancelAnimationFrame(this.vvRafId);
    this.vvRafId = 0;
    window.visualViewport?.removeEventListener(
      'resize',
      this.onVisualViewportChange,
    );
    window.visualViewport?.removeEventListener(
      'scroll',
      this.onVisualViewportChange,
    );
    this.viewportObs.disconnect();
    this.bottomReserveView?.destroy();
    this.bottomReserveView = undefined;
    this.bottomReserveH = 0;
    this.viewport.removeEventListener('scroll', this.onNativeScroll);
    this.viewport.removeEventListener('wheel', this.onScrollIntent);
    this.viewport.removeEventListener('touchmove', this.onScrollIntent);
    this.viewport.removeEventListener('pointerdown', this.onScrollIntent);
    this.viewport.removeEventListener('keydown', this.onScrollIntent);
    const errors: unknown[] = [];
    try { this.unmountAll(); } catch (error) { errors.push(error); }
    const source = this.boundSource;
    this.boundSource = null;
    this.windowContext = {};
    this.prefix = [0];
    this.dirtyPrefix = false;
    this.noOlder = false;
    this.noNewer = false;
    this.fullyVisibleIds.clear();
    this.olderDemand.error = null;
    this.newerDemand.error = null;
    this.resizeDeferred = false;
    this.suppressScrollBalance = false;
    this.lastScrollTop = 0;
    this.viewport.scrollTop = 0;
    try { source?.destroy(); } catch (error) { errors.push(error); }
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, 'Chat binding disposal failed');
  }

  destroy(): void {
    this.cancelArrivalWindow();
    this.cancelMotion();
    this.releasePresentation();
    this.programmaticScrollTop = null;
    if (this.state === 'destroyed') return;
    try { this.unbind(); } finally { this.state = 'destroyed'; }
  }

  /** The subscription owns delivery; the source receives its physical cancellation signal. */
  private windowItems(request: CbSourceWindowRequest): Observable<CbItem<T>[]> {
    return defer(() => this.source.loadWindow(request, this.windowContext));
  }

  // ---------- Prefix sum / height ----------

  /** Recompute prefix when dirty (O(n), n = mounted.length). mount/unmount/onElHeight mark it dirty; call before reading prefix. */
  private flushPrefix(): void {
    if (!this.dirtyPrefix) return;
    const p = [0];
    let acc = 0;
    for (const e of this.mounted) {
      p[p.length - 1] = acc;
      acc += e.height;
      p.push(acc);
    }
    this.prefix = p;
    this.dirtyPrefix = false;
  }

  /** Distance from the top of idx to the content top = Σ older-neighbor heights = prefix[idx]. */
  private topOf(idx: number): number {
    this.flushPrefix();
    return this.prefix[idx] ?? 0;
  }

  // totalH adds tailCapH (the cap is below every real item, so it never enters prefix[]/topOf — only the total). prefix
  // stays real-items-only; this keeps belowTarget/atBottom honest (the cap really is below the last real item) and topOf exact.
  private totalH(): number {
    this.flushPrefix();
    return (
      (this.prefix.length > 0 ? this.prefix[this.prefix.length - 1] : 0) +
      this.bottomReserveH
    );
  }

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
  private mountBatch(
    merged: CbItem<T>[],
    side: 'init' | 'older' | 'newer',
  ): void {
    if (merged.length === 0) return;
    if (side === 'newer') {
      const oldTail = this.mounted[this.mounted.length - 1] ?? null;
      for (let i = 0; i < merged.length; i++) {
        const prev =
          i > 0
            ? merged[i - 1]
            : this.mounted.length > 0
              ? this.mounted[this.mounted.length - 1].item
              : null;
        this.mounted.push(
          this.createEntry(
            merged[i],
            prev,
            merged[i + 1] ?? null,
            undefined,
          ),
        );
      }
      oldTail?.vs.updateNext?.(merged[0]);
    } else {
      // init / older both prepend (when init, mounted is empty, anchorEl = null → appendChild)
      const oldHeadEntry = this.mounted[0] ?? null;
      const anchorEl = oldHeadEntry ? oldHeadEntry.el : null;
      const oldHead = oldHeadEntry?.item ?? null;
      const fresh: Entry<T>[] = [];
      for (let i = 0; i < merged.length; i++) {
        const prev = i > 0 ? merged[i - 1] : null;
        fresh.push(
          this.createEntry(
            merged[i],
            prev,
            merged[i + 1] ?? oldHead,
            anchorEl,
          ),
        ); // never animate prepended history
      }
      this.mounted.unshift(...fresh);
      if (oldHeadEntry) {
        oldHeadEntry.vs.update(oldHeadEntry.item, merged[merged.length - 1]);
        this.pendingMeasure.push(oldHeadEntry);
      }
    }
    this.dirtyPrefix = true;
    if (side !== 'older') this.measurePending();
  }

  /** Mount hidden only until synchronous measurement; new content has no entry effect. */
  private createEntry(
    item: CbItem<T>,
    prev: CbItem<T> | null,
    next: CbItem<T> | null,
    anchorEl?: HTMLElement | null,
  ): Entry<T> {
    const vs = this.hooks.createItem(item, prev);
    vs.updateNext?.(next);
    const el = vs.el;
    el.dataset['cbId'] = String(item.id);
    if (anchorEl !== undefined && anchorEl !== null)
      this.content.insertBefore(el, anchorEl);
    else if (this.bottomReserveView)
      this.content.insertBefore(el, this.bottomReserveView.el);
    else this.content.appendChild(el);
    const entry: Entry<T> = {
      item,
      el,
      vs,
      height: 0,
      tailHeight: 0,
      transient: false,
      optimistic: false,
    }; // real height set by measurePending()
    el.classList.add('cb-pending');
    this.pendingMeasure.push(entry);
    this.mounting = true; // suppress the first report (same as id-based)
    this.mounting = false;
    this.notifyItemMounted(entry);
    return entry;
  }

  private notifyItemMounted(entry: Entry<T>): void {
    if (!entry.item.displayInterval && !this.onItemMounted) return;
    const element = entry.vs;
    queueMicrotask(() => {
      if (
        this.inactive ||
        entry.vs !== element ||
        !this.mounted.includes(entry)
      )
        return;
      if (entry.item.displayInterval && this.source.watchInterval) {
        const interval = entry.item.displayInterval;
        const gapId = `interval:${entry.item.id}`;
        this.gapCoordinator.register({
          id: gapId,
          left: interval.left,
          right: interval.right,
          kind: 'serverPending',
          direction: 'older',
        });
        this.gapEntries.set(gapId, entry);
        const subscription = new Subscription();
        this.intervalSubscriptions.set(entry, subscription);
        subscription.add(this.source.watchInterval(entry.item).subscribe({
          next: (items) => {
            if (this.intervalSubscriptions.get(entry) !== subscription) return;
            if (this.gapCoordinator.stageReadyPage(gapId, {
              left: interval.left,
              right: interval.right,
              messages: items,
            })) {
              this.scheduler?.requestBalance();
            }
          },
          // Transport owns reconnect. An exhausted stream leaves the gap visible;
          // remounting it creates a fresh consumer rather than erasing history.
          error: () => {},
        }));
      }
      this.onItemMounted?.(entry.item, element);
    });
  }

  private releaseInterval(entry: Entry<T>): void {
    const subscription = this.intervalSubscriptions.get(entry);
    this.intervalSubscriptions.delete(entry);
    subscription?.unsubscribe();
    const gapId = `interval:${entry.item.id}`;
    if (this.gapEntries.get(gapId) === entry) {
      this.gapEntries.delete(gapId);
      this.gapCoordinator.remove(gapId);
    }
  }

  /** Splice only the subscribed interval. Outside renderers remain mounted and
   * the current real viewport anchor is captured at delivery, not request time. */
  private replaceDisplayInterval(entry: Entry<T>, items: CbItem<T>[]): void {
    const index = this.mounted.indexOf(entry);
    const interval = entry.item.displayInterval;
    if (this.inactive || index < 0 || !interval) return;
    if (items.length === 1 && items[0].id === entry.item.id) return;
    const before = this.captureLayoutChange();
    const latestGap = !this.mounted.slice(index + 1).some(row => !row.optimistic && !row.transient) &&
      (entry.item.boundary === 'newest' || entry.item.boundary === 'both');
    const successor = this.mounted[index + 1];
    this.releaseInterval(entry);
    this.disposeEntry(entry);
    this.mounted.splice(index, 1);
    const replacements = this.mergeBatch(items);
    if (!replacements.length) {
      if (entry.item.boundary === 'oldest' || entry.item.boundary === 'both') this.noOlder = true;
      if (entry.item.boundary === 'newest' || entry.item.boundary === 'both') this.noNewer = true;
    }
    let previous = this.mounted[index - 1]?.item ?? null;
    for (let offset = 0; offset < replacements.length; offset++) {
      const item = replacements[offset];
      const next = replacements[offset + 1] ?? successor?.item ?? null;
      const replacement = this.createEntry(item, previous, next, successor?.el ?? null);
      this.mounted.splice(index + offset, 0, replacement);
      previous = item;
    }
    this.mounted[index - 1]?.vs.updateNext?.(this.mounted[index]?.item ?? null);
    if (successor) {
      successor.vs.update(successor.item, previous);
      this.pendingMeasure.push(successor);
    }
    this.dirtyPrefix = true;
    this.measurePending();
    if (latestGap) this.finishLayoutChange(before);
    else this.restoreLayout(before.snapshot);
    this.trimOlder();
    this.trimNewer();
    this.emit();
    this.onViewportStateChanged();
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
   * group-head / date must be recomputed); settle (a demanded real confirmed an optimistic transient).
   */
  private rebuildEntry(
    entry: Entry<T>,
    newItem: CbItem<T> = entry.item,
  ): void {
    const idx = this.mounted.indexOf(entry);
    if (idx < 0) return;
    const newPrev = idx > 0 ? this.mounted[idx - 1].item : null;
    const newNext = this.mounted[idx + 1]?.item ?? null;
    const newVs = this.hooks.createItem(newItem, newPrev);
    newVs.updateNext?.(newNext);
    const newEl = newVs.el;
    newEl.dataset['cbId'] = String(newItem.id);
    this.content.insertBefore(newEl, entry.el);
    this.releaseInterval(entry);
    this.disposeEntry(entry);
    entry.vs = newVs;
    entry.el = newEl;
    entry.item = newItem; // no-op for ghost reveal (same ref); replaces item for settle
    entry.height = 0; // real height set by measurePending() (loadOlder measures after rebuild)
    newEl.classList.add('cb-pending');
    this.pendingMeasure.push(entry);
    this.mounting = true;
    entry.tailHeight = 0;
    this.mounting = false;
    this.dirtyPrefix = true;
    this.notifyItemMounted(entry);
  }

  /** Unmount the oldest (mounted[0], DOM top). Does not compensate scrollTop (the caller trimOlder compensates inside `shifting`). */
  private unmountTop(): boolean {
    if (this.mounted.length === 0) return false;
    const e = this.mounted[0];
    this.mounted.shift();
    this.dirtyPrefix = true;
    this.releaseInterval(e);
    this.disposeEntry(e);
    return true;
  }

  /** Unmount the newest (mounted last, DOM bottom). */
  private unmountBot(): boolean {
    if (this.mounted.length === 0) return false;
    const e = this.mounted[this.mounted.length - 1];
    this.mounted.pop();
    this.mounted[this.mounted.length - 1]?.vs.updateNext?.(null);
    this.dirtyPrefix = true;
    this.releaseInterval(e);
    this.disposeEntry(e);
    return true;
  }

  /** Revoke mounted ownership before cleanup callbacks; the caller preserves positioning. */
  private unmountAt(i: number): boolean {
    if (i < 0 || i >= this.mounted.length) return false;
    const e = this.mounted[i];
    const binding = this.bindingAbort;
    this.mounted.splice(i, 1);
    this.pendingMeasure = this.pendingMeasure.filter((entry) => entry !== e);
    this.dirtyPrefix = true;
    const errors: unknown[] = [];
    try {
      this.disposeEntry(e);
    } catch (error) {
      errors.push(error);
    }
    if (this.bindingAbort !== binding || this.inactive) {
      if (errors.length) throw new AggregateError(errors, 'Chat item removal failed');
      return true;
    }
    this.mounted[i - 1]?.vs.updateNext?.(this.mounted[i]?.item ?? null);
    const successor = this.mounted[i];
    if (successor) {
      const prev = i > 0 ? this.mounted[i - 1].item : null;
      const next = this.mounted[i + 1]?.item ?? null;
      successor.vs.update(successor.item, prev);
      successor.vs.updateNext?.(next);
      const height = successor.el.offsetHeight;
      if (height > 0 && height !== successor.height) successor.height = height;
    }
    this.dirtyPrefix = true;
    if (errors.length) throw new AggregateError(errors, 'Chat item removal failed');
    return true;
  }

  /** Attempt every release even if activity teardown throws. DOM stays intact
   * through pre-destruction, but removal never waits for a frame or timer. */
  private disposeEntry(entry: Entry<T>): void {
    // Reentrant unbind must not mistake this already-revoked row for an orphan.
    delete entry.el.dataset['cbId'];
    const errors: unknown[] = [];
    for (const cleanup of [
      () => this.releaseInterval(entry),
      () => entry.vs.predestory?.(),
      () => entry.vs.destroy(),
      () => entry.el.remove(),
    ]) {
      try { cleanup(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'Chat item disposal failed');
  }

  private unmountAll(): void {
    const entries = this.mounted;
    this.mounted = [];
    const errors: unknown[] = [];
    for (const entry of entries) {
      try { this.disposeEntry(entry); } catch (error) { errors.push(error); }
    }
    this.prefix = [0];
    this.dirtyPrefix = true;
    this.pendingMeasure = [];
    if (errors.length) throw new AggregateError(errors, 'Chat window disposal failed');
    // Invariant (dev-only — isDevMode() is stripped in AOT, so prod pays nothing): after unmounting every tracked
    // row, .msg-content must hold NO kernel-tagged ([data-cb-id]) children.
    // Every asynchronous mount path delivers inside its owning subscription.
    // Delivery after cleanup would create orphans. THROW rather than silently sweep:
    // sweeping would (a) leak the orphan host's Angular component ref + ResizeObserver (there is no handle to
    // destroy() them) and (b) mask the root cause behind a quiet warn. The sentinel (#topSentinel) and the tail cap
    // carry no data-cb-id, so they never trip this.
    if (isDevMode()) {
      const orphanCount = this.content.querySelectorAll('[data-cb-id]').length;
      if (orphanCount > 0) {
        throw new Error(
          `[chat-box] unmountAll invariant violated: ${orphanCount} orphaned row(s) remain in content — a stale asynchronous operation mounted rows outside the current binding/window`,
        );
      }
    }
  }

  // ---------- balance: checkpoint + loading ----------

  /** Viewport resized (soft keyboard open/close, orientation change, window resize). This is a *reflow*, not a
   *  checkpoint: re-measure vh and keep the reading position.
   *  - Was pinned to bottom (anchor.mode === 'bottom', captured BEFORE measureVh so the at-bottom test uses the OLD vh):
   *    re-apply the bottom anchor (re-pin to the new bottom) and do NOT load/trim — the transient balance a shrink
   *    triggers is the visible jitter, and a re-pin is the only correct response.
   *  - Mid-screen: scrollTop is vh-independent (topOf(anchor)+offset), so it is unchanged in absolute px — the same
   *    line stays in view; DOM balancing is a no-op unless the user happens to sit at an edge.
   *  Content-driven rebalances (item height changes, native scroll) still run via onElHeight + onNativeScroll. */
  private onViewportResize(): void {
    if (this.inactive) return;
    const width = this.viewport.clientWidth;
    if (width === this.viewportWidth && this.viewport.clientHeight === this.vh) return;
    if (this.viewport.clientHeight === 0) {
      this.cancelArrivalWindow();
      this.cancelMotion();
      this.releasePresentation();
    }
    if (width !== this.viewportWidth) {
      this.viewportWidth = width;
      this.scheduleLayoutRemeasure();
    }
    if (this.layoutSettleTimer !== undefined) {
      this.measureVh();
      return;
    }
    // Immunity frame: a route-transition animation is in flight. Hold the current pin so the
    // message list does not jump under the sliding overlay; flushViewportResize runs this once on thaw.
    if (this.isFrozen()) {
      this.resizeDeferred = true;
      return;
    }
    const anchor = this.isFollowingBottom() ? { mode: 'bottom' as const } : this.captureComposerAnchor();
    const before = this.snapshotLayout();
    this.cancelArrivalWindow();
    this.cancelMotion();
    this.measureVh();
    const offset = compensateScrollLayout(before, this.snapshotLayout()) ?? visualOffsetOf(before);
    this.settlePresentation(offset);
    if (anchor.mode === 'bottom' && this.mounted.length > 0) {
      this.applyAnchor(anchor); // re-pin to the new bottom (new vh)
      this.releasePresentation();
      // applyAnchor wrote scrollTop under shifting, but that guard resets synchronously — before the async scroll event
      // is dispatched. Set the one-shot flag so onNativeScroll swallows that event. This is the ONE site that needs it:
      // a shrink can pin at a bottom whose newer end is trimmed (noNewer=false), where an armed balance would loadNewer
      // and jump. (Every other pin site has noNewer=true ⇒ the follow-on balance is a harmless no-op.)
      this.suppressScrollBalance = true;
      return;
    }
    this.onViewportStateChanged();
  }

  private onScrollIntent = (event: Event) => {
    if (event.type === 'pointerdown') return; // Scrollbars are hidden while locked; links and taps stay usable.
    if (event instanceof KeyboardEvent) {
      const target = event.target;
      if (target instanceof HTMLElement && target.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (!['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) return;
    }
    if (this.outOfBounds) {
      event.preventDefault();
      return;
    }
    this.navigationGeneration++;
    const upward = event instanceof WheelEvent ? event.deltaY < 0
      : event instanceof KeyboardEvent ? ['ArrowUp', 'PageUp', 'Home'].includes(event.key) || (event.key === ' ' && event.shiftKey)
        : false;
    if (upward) this.followIntent = false;
    this.cancelArrivalWindow();
    this.cancelMotion();
    this.programmaticScrollTop = null;
  };

  private onNativeScroll = () => {
    if (this.shifting || this.inactive) return;
    if (this.suppressScrollBalance) {
      this.suppressScrollBalance = false;
      if (this.programmaticScrollTop !== null &&
          Math.abs(this.viewport.scrollTop - this.programmaticScrollTop) < 0.001) return;
    } // Only consume the actual reflow write, never a later user scroll.
    // Native scroll events arrive after the synchronous write guard has reset.
    // Ignore only our actual last offset, not arbitrary scrolls during animation.
    const programmed = this.programmaticScrollTop;
    this.programmaticScrollTop = null;
    if (programmed !== null && Math.abs(this.viewport.scrollTop - programmed) < 0.001) {
      this.onViewportStateChanged();
      return;
    }
    if (this.outOfBounds) {
      this.setScrollTopProgrammatic(this.lockedScrollTop);
      this.onViewportStateChanged();
      return;
    }
    this.navigationGeneration++;
    this.followIntent = false;
    this.cancelArrivalWindow();
    this.cancelMotion();
    this.programmaticScrollTop = null;
    this.onViewportStateChanged();
  };

  private onViewportStateChanged(): void {
    if (this.inactive) return;
    this.syncDemandRegions();
    this.scheduleDomBalance();
  }

  private scheduleDomBalance(): void {
    if (this.inactive) return;
    this.scheduler?.requestBalance();
  }

  /** Keep source subscriptions aligned with the viewport independently from DOM balancing and animation gates. */
  private syncDemandRegions(): void {
    if (!this.steady || this.layoutSettleTimer !== undefined) return;
    const st = this.viewport.scrollTop;
    const atTop = st < this.cfg.edge;
    if (atTop && !this.noOlder) this.startOlderDemand();
    else this.cancelOlderDemand();
    // A synchronous older delivery may have changed both geometry and binding.
    if (!this.steady) return;
    const atBottom =
      this.totalH() - this.vh - this.viewport.scrollTop < this.cfg.edge;
    // Ordinary newer paging remains viewport-driven while browsing history.
    // At the live tail, demand stays mounted even when the viewport is far away.
    if (this.arrivalDemand || this.noNewer || atBottom || !this.mounted.length) this.startNewerDemand();
    else this.cancelNewerDemand();
  }

  /** Synchronous DOM checkpoint. Demand subscription lifetime is maintained separately by syncDemandRegions. */
  private balance(): void {
    if (this.inactive) return;
    if (isDevMode() && this.closeCheckpoint) return; // debug: turn off the mount checkpoint (do not trigger loadOlder/loadNewer; removed in prod AOT)
    const st = this.viewport.scrollTop;
    this.scrollDir(st);
    this.lastScrollTop = st;

    this.onViewportPaint?.();
    const admission = this.gapCoordinator.admitOne((item) => item.id, {
      pinToBottom: this.isPinnedToBottom(),
      distanceToViewport: (gap) => {
        const entry = this.gapEntries.get(gap.id);
        const idx = entry ? this.mounted.indexOf(entry) : -1;
        if (idx < 0) return Number.POSITIVE_INFINITY;
        return distanceToViewportCenter(
          this.topOf(idx),
          this.mounted[idx].height,
          this.viewport.scrollTop,
          this.vh,
        );
      },
    });
    if (admission.admitted) {
      const entry = this.gapEntries.get(admission.admitted.id);
      if (entry) {
        this.replaceDisplayInterval(entry, [...admission.filteredMessages]);
        this.consumeMountedTombs();
      }
    } else if (this.pendingNewerDelivery) {
      const result = this.pendingNewerDelivery;
      this.pendingNewerDelivery = null;
      this.commitNewerDelivery(result);
    } else if (this.pendingOlderDelivery) {
      const result = this.pendingOlderDelivery;
      this.pendingOlderDelivery = null;
      this.commitOlderDelivery(result);
    }
    if (
      admission.hasMoreReady ||
      this.pendingNewerDelivery !== null ||
      this.pendingOlderDelivery !== null
    ) {
      this.scheduler?.requestBalance();
    }
    this.resolveMotionTarget();
    this.emit();
  }

  private startOlderDemand(): void {
    if (this.layoutSettleTimer !== undefined) return;
    const edge = this.olderDemand;
    if (
      edge.active ||
      edge.error !== null ||
      this.noOlder ||
      !this.mounted.length
    )
      return;
    edge.subscribe(
      defer(() =>
        this.source.requestOlder(this.olderCursorId(), this.cfg.mountItem),
      ),
      (result) => {
        if (this.scheduler && this.scheduler.phase !== 'idle') {
          this.pendingOlderDelivery = result;
          this.scheduler.requestBalance();
          return;
        }
        this.commitOlderDelivery(result);
      },
    );
  }

  private commitOlderDelivery(result: CbDemandResult<T>): void {
    const applied = this.applyOlderResult(result);
    this.consumeMountedTombs();
    if (!applied) return;
    this.trimNewer();
    this.emit();
    this.onViewportStateChanged();
  }

  private startNewerDemand(): void {
    if (this.layoutSettleTimer !== undefined) return;
    const edge = this.newerDemand;
    if (edge.active || edge.error !== null) return;
    edge.subscribe(
      defer(() => {
        const hasMountedHistory = this.mounted.some(
          (entry) =>
            !entry.transient &&
            !entry.optimistic,
        );
        if (hasMountedHistory) {
          return this.source.requestNewer(
            this.newerCursorId(),
            this.cfg.mountItem,
          );
        }
        return this.source.requestMessagesForEmptyWindow(this.cfg.mountItem);
      }),
      (result) => {
        if (this.scheduler && this.scheduler.phase !== 'idle') {
          this.pendingNewerDelivery = result;
          this.scheduler.requestBalance();
          return;
        }
        this.commitNewerDelivery(result);
      },
    );
  }

  private commitNewerDelivery(result: CbDemandResult<T>): void {
    const layout = this.snapshotLayout();
    const before = this.mounted.map((entry) => ({
      entry, height: this.messageHeight(entry), seqs: [...this.entrySeqs(entry.item)],
    }));
    const known = new Set(before.flatMap((row) => [...row.seqs]));
    const attached = this.isFollowingBottom();
    const loaded = this.applyNewerResult(result);
    if (loaded <= 0) {
      this.consumeMountedTombs();
      return;
    }
    this.reconcileOptimistic();
    const arrivals = this.mounted.flatMap((entry) => {
      const seqs = this.entrySeqs(entry.item).filter((seq) => !known.has(seq));
      return seqs.length ? [{ entry, seqs }] : [];
    });
    const addedHeight = arrivals.reduce((height, { entry }) => {
      const old = before.find((row) => row.entry === entry);
      return height + Math.max(0, this.messageHeight(entry) - (old?.height ?? 0));
    }, 0);
    const survived = this.restoreLayout(layout);
    this.trimOlder();
    if (survived && attached && addedHeight > 0) {
      this.scheduleArrivalWindow(attached, addedHeight, layout);
    }
    this.consumeMountedTombs();
    this.emit();
    this.onViewportStateChanged();
  }

  /**
   * Load older: getOlder (cursor = olderCursorId(), the oldest non-transient/optimistic mounted item) + mergeItems +
   * prepend mount + old-ghost reveal rebuild. **Pure load — no trim** (split: the caller — balance — trims the opposite
   * end after this resolves). **Manual compensation**: the total above-viewport delta (new batch measured height + ghost
   * rebuild delta) is applied once via compensateAbove (viewport does not jump). The ghost reveal and the new batch share
   * one measurePending (`measuring` suppresses onElHeight compensation → compensation is unified here). absorbBoundary is
   * called only after revalidate passes (prevents a fling-back from falsely locking noOlder → the oldest batch never
   * mounting again).
   */
  private applyOlderResult(result: CbDemandResult<T>): boolean {
    const edge = this.olderDemand;
    if (result.kind === 'error') {
      edge.error = result.error;
      return false;
    }
    edge.error = null;
    if (!this.revalidateTop()) return false; // A fling may reverse while the request is pending.
    if (result.kind === 'boundary') {
      this.noOlder = true;
      return true;
    }
    const merged = this.mergeBatch(result.items);
    if (this.inactive || merged.length === 0) {
      if (merged.length === 0) {
        this.noOlder = true;
      }
      return true;
    }
    this.absorbBoundary(merged); // phase 0: absorb boundary only after passing
    // Flush unobserved composer geometry before capturing the delivery-time
    // layout. Restore the surviving messages' painted position after prepend,
    // retaining any active transform instead of clamping it away.
    this.onRegionResize();
    const before = this.snapshotLayout();
    this.mountBatch(merged, 'older');
    this.measurePending();
    this.restoreLayout(before);
    return true;
  }

  /** Apply a delivered newer batch synchronously, before releasing control. */
  private applyNewerResult(result: CbDemandResult<T>): number {
    const edge = this.newerDemand;
    if (result.kind === 'error') {
      edge.error = result.error;
      return 0;
    }
    if (result.kind === 'boundary') {
      this.noNewer = true;
      this.arrivalDemand = false;
      return 0;
    }
    const batch = result.items;
    edge.error = null;
    if (batch.length === 0) {
      this.noNewer = true;
      return 0;
    }
    const reachesNewest = batch.some(
      (it) => it.boundary === 'newest' || it.boundary === 'both',
    );
    // A live append moves the global newest edge. The item that carried the previous newest marker is now an ordinary
    // interior row; leaving that marker mounted makes trimOlder stop there forever, so every later full backlog page
    // grows the window by 50 rows. Preserve `oldest` when a sole-item `both` edge is extended.
    if (!reachesNewest) this.clearStaleNewestBoundary();
    this.absorbBoundary(batch); // phase 0: absorb boundary only after passing
    // Authoritative: a newer batch reaches the global newest iff it carries the 'newest' marker. A full page WITHOUT it
    // means more newer data remains (a large SSE backlog spans multiple pages) → noNewer=false so the next signal/balance
    // loads further. absorbBoundary is sticky (only ever sets true), so without this a partial backlog page left the kernel
    // falsely believing it was at the newest — stranding the remaining newer messages off-window and blocking further
    // loads (revalidateBottom is gated on !noNewer).
    this.noNewer = reachesNewest;
    if (reachesNewest) this.arrivalDemand = false;

    const count0 = this.mounted.length;

    // Merge historical arrivals before mounting; absorbed album members do not allocate new rows.
    const absorbed = this.mountNewerReals(this.mergeBatch(batch)); // items folded into existing albums (no new mount)

    // Pending presentation survives incomplete history pages; only confirmation,
    // explicit discard, or window teardown removes an optimistic entry.

    this.dirtyPrefix = true;
    this.measurePending();
    this.emit();
    // mounted delta + absorbed: an absorbed item changes the view (album grew) and may need reconcile (its optimistic is
    // still mounted), so it counts as progress and the demand callback still reconciles its optimistic bubble.
    return this.mounted.length - count0 + absorbed;
  }

  private cancelOlderDemand(): void {
    this.olderDemand.cancel();
  }

  private cancelNewerDemand(): void {
    this.newerDemand.cancel();
  }

  retryOlder(): void {
    if (this.olderDemand.error === null || this.inactive) return;
    this.olderDemand.error = null;
    this.olderDemand.retrying = true;
    this.startOlderDemand();
  }

  retryNewer(): void {
    if (this.newerDemand.error === null || this.inactive) return;
    this.newerDemand.error = null;
    this.newerDemand.retrying = true;
    this.startNewerDemand();
  }

  notifyNewerAvailable(previousLatestSeq?: number): void {
    if (!this.steady) return;
    const mountedLatest = previousLatestSeq === undefined
      ? this.noNewer
      : this.mounted.some((entry) => !entry.optimistic &&
          !entry.transient && this.entrySeqs(entry.item).includes(previousLatestSeq));
    if (!mountedLatest) return;
    this.arrivalDemand = true;
    this.noNewer = false;
    this.startNewerDemand();
  }

  /**
   * Mount a batch of real (non-pending) items before the optimistic/transient tail block, dispatching each by whether
   * it confirms an existing optimistic/transient entry. Insertion point = right after the last real entry (= the cursor);
   * the optimistic block shifts down (it is at/below the viewport, so no scrollTop compensation is needed — positionAtBottom
   * in the demand callback follows to reveal it). Albums are already merged by the caller.
   *
   * Returns the number of items ABSORBED into existing entries (no new mount). Mounted items are observable via the
   * mounted.length delta at the caller; absorbed items are not (they fold in without a new entry), so they are reported
   * explicitly to keep loadNewer's progress count honest (a pure-absorb batch still did work).
   */
  private mountNewerReals(
    reals: CbItem<T>[],
  ): number {
    if (reals.length === 0) return 0;
    // Insertion point = right after the last real entry (the cursor). When NO real is mounted — the window is entirely
    // optimistic/transient, i.e. the first confirm in an empty thread — default to 0 so the new real becomes the
    // first/oldest entry with prev=null (correct group-head flags), rather than appending it after the
    // optimistic block where its prev would be the transient it is about to replace.
    let insertIdx = 0;
    for (let i = this.mounted.length - 1; i >= 0; i--) {
      const e = this.mounted[i];
      if (!e.transient && !e.optimistic) {
        insertIdx = i + 1;
        break;
      }
    }
    const absorb = this.hooks.absorbTail;
    let absorbed = 0; // items folded into an existing entry (no new mount) — reported up so callers count them as progress
    for (const item of reals) {
      // Confirm: an in-flight optimistic/transient send whose clientMessageId matches this real. The real carries a
      // fresh server id (≠ the optimistic's clientMessageId-as-id), so the pair is matched by clientMessageId, not id.
      // No clientMessageId → a plain incoming message (no optimistic bubble to settle). An already-mounted real (dup,
      // by id — an incoming that raced with a load) is skipped.
      const confirm = this.itemFulfilledCids(item).some(
        (c) => this.indexOfClientMsgId(c) >= 0,
      );
      if (!confirm && this.indexOfId(item.id) >= 0) continue; // already-mounted real (dup) → skip

      // Cross-batch album absorb: an item the hook folds into the running newest real — `target` = mounted[insertIdx-1]
      // (the entry this item would follow). Absorbing morphs target in place (no new bubble, insertIdx unchanged) so a
      // run of absorbable items all fold into it; the first non-absorbable item mounts normally and becomes the new
      // newest, ending the run. Self-correcting — no sticky mode. Only offered when target is a stable real.
      //
      // Absorption retains every member's client identity for duplicate reconciliation.
      if (absorb && insertIdx > 0) {
        const target = this.mounted[insertIdx - 1];
        if (
          target &&
          !target.optimistic &&
          !target.transient
        ) {
          const merged = absorb(target.item, item);
          if (merged !== null) {
            this.measuring = true; // suppress onElHeight compensation/balance during synchronous album rendering
            target.item = merged;
            const tp = insertIdx > 1 ? this.mounted[insertIdx - 2].item : null;
            target.vs.update(merged, tp);
            const h = target.el.offsetHeight; // real height after the album grew (integer — layout.ts Math.rounds every row)
            if (h !== target.height) {
              target.height = h;
              this.dirtyPrefix = true;
            }
            target.tailHeight = target.vs.measureTailHeight?.() ?? 0;
            this.measuring = false;
            absorbed++; // an absorbed item changes the view (album grew) without growing mounted[] — counted so a pure-absorb signal still reports progress (n > 0) and reconcile runs
            continue; // absorbed — no new entry; target is still the newest real (insertIdx unchanged)
          }
        }
      }

      const anchorEl =
        insertIdx < this.mounted.length ? this.mounted[insertIdx].el : null;
      const prev = insertIdx > 0 ? this.mounted[insertIdx - 1].item : null;
      const next = this.mounted[insertIdx]?.item ?? null;
      const entry = this.createEntry(
        item,
        prev,
        next,
        anchorEl,
      );
      this.mounted.splice(insertIdx, 0, entry);
      this.mounted[insertIdx - 1]?.vs.updateNext?.(item);
      insertIdx++;
    }
    this.dirtyPrefix = true;
    return absorbed;
  }

  /** Remove mounted optimistic duplicates synchronously, matching every album member's client identity. */
  private reconcileOptimistic(): void {
    // Albums fulfill all members, not only their head.
    const fulfilled = new Set<string>();
    for (const e of this.mounted) {
      if (e.transient || e.optimistic) continue; // only reals fulfill an optimistic
      for (const c of this.itemFulfilledCids(e.item)) fulfilled.add(c);
    }
    // An optimistic tail entry whose cid is fulfilled is a duplicate → remove it synchronously. The scan is
    // the inverse of the old target→source pairing, so it naturally covers multi-cid albums (one album fulfills many
    // optimistics) AND the single-confirm case (one cid → one optimistic).
    const toRemove: Entry<T>[] = [];
    for (const e of this.mounted) {
      if (!e.optimistic) continue;
      if (
        e.item.clientMessageId !== undefined &&
        fulfilled.has(e.item.clientMessageId)
      )
        toRemove.push(e);
    }
    if (toRemove.length === 0) return;
    this.resorting = true;
    try {
      // The enclosing newer-delivery transaction restores its immutable layout
      // once after reconciliation, avoiding a second motion-target rebase here.
      for (const source of toRemove) {
        const i = this.mounted.indexOf(source);
        if (i < 0) continue;
        if (this.motionRequest && this.itemHasId(source.item, this.motionRequest.id)) {
          const real = this.mounted.find(row => !row.optimistic && !row.transient &&
            source.item.clientMessageId !== undefined &&
            this.itemFulfilledCids(row.item).includes(source.item.clientMessageId));
          if (real) this.motionRequest.id = real.item.id;
        }
        this.unmountAt(i);
      }
      this.dirtyPrefix = true;
      this.measurePending();
    } finally {
      this.resorting = false;
    }
    this.emit();
  }


  /** Trim the newer end (bottom, mounted last). **Keep a buffer below the viewport**: after trimming, the content bottom
   * (totalH - h) must still be > viewport bottom (st + vh) + edge, otherwise do not trim — prevents loadOlder's
   * compensateAbove from pushing st up and then trim cutting into the viewport → st exceeds total → false atBottom
   * → loadNewer wasAtBottom jumps to the newest end. Trimming the newest end resets noNewer (loadNewer can load it back).
   * No compensation (the bottom is below the viewport). */
  private trimNewer(): void {
    if (this.resorting) return; // never trim midway through identity reconciliation
    let trimmed = false;
    while (this.mounted.length > 1) {
      const last = this.mounted[this.mounted.length - 1];
      // Never trim an in-flight optimistic/transient send (not in the source → trimming would lose it).
      // The optimistic block is atomic — reaching it aborts the trim (all-or-nothing; only
      // reconcileOptimistic removes a member, never trim). This is the "min mount height reserved" guarantee: while
      // sends sit at the tail, no bottom trim runs at all, so currently-displayed messages are never cut.
      if (last.transient || last.optimistic) break;
      this.flushPrefix();
      const h = last.height;
      if (
        this.totalH() - h > this.threshold &&
        this.totalH() - h - (this.viewport.scrollTop + this.vh) > this.cfg.edge
      ) {
        this.unmountBot();
        trimmed = true;
      } else break;
    }
    if (trimmed) {
      this.arrivalDemand = false;
      this.cancelNewerDemand();
      this.noNewer = false;
    }
  }

  /** Trim the older end (top, mounted[0]). **Keep a buffer above the viewport**: the projected scrollTop after the
   *  cumulative trim (orig - cumH) minus the candidate h must stay > edge. The anchor is captured once (the topmost-
   *  visible item — the buffer guarantees it is never mounted[0]); after the loop, applyAnchor sets scrollTop =
   *  topOf(anchor)+offset, and topOf(anchor) has dropped by exactly cumH, so scrollTop = orig - cumH (equivalent to the
   *  old per-iteration `scrollTop -= h`, and to re-pinning when the viewport was at the bottom). Trimming resets noOlder. */
  private trimOlder(): void {
    if (this.resorting) return; // rule 4a: never trim during a resort
    const anchor = this.captureAnchor();
    const previousOffset = this.visualOffset;
    let trimmed = false;
    let cumH = 0;
    while (this.mounted.length > 1) {
      const first = this.mounted[0];
      // Never trim transient/optimistic entries or the global-newest real item (defensive — the
      // newest normally sits at the tail, but the guard holds regardless of position).
      if (
        first.transient ||
        first.optimistic ||
        first.item.boundary === 'newest' ||
        first.item.boundary === 'both'
      )
        break;
      const h = first.height;
      if (
        this.totalH() - h > this.threshold &&
        this.viewport.scrollTop - cumH - h > this.cfg.edge
      ) {
        this.unmountTop();
        cumH += h;
        trimmed = true;
      } else break;
    }
    if (trimmed) {
      this.noOlder = false;
      this.applyAnchor(anchor, previousOffset); // Rebase from pre-removal geometry, before browser clamping.
    }
  }

  // ---------- Height / viewport stabilization ----------

  /** Commit synchronous measurements only. The enclosing layout transaction owns positioning. */
  private commitMeasuredHeight(entry: Entry<T>, h: number): void {
    if (this.inactive) return;
    const old = entry.height;
    const tailHeight = entry.vs.measureTailHeight?.() ?? 0;
    if (old === h && entry.tailHeight === tailHeight) return;
    entry.height = h;
    entry.tailHeight = tailHeight;
    this.dirtyPrefix = true;
  }

  /** Whether an item represents the given msgId — matches {@link CbItem.id} OR any member in {@link CbItem.ids}
   *  (so a jump to a non-head album member still resolves to its album item). */
  private itemHasId(item: CbItem<T>, id: number): boolean {
    if (item.id === id) return true;
    const ids = item.ids;
    return ids !== undefined && ids.includes(id);
  }

  /** Resolve a message or album-member identity to its current mounted index. O(n). */
  private indexOfId(id: number): number {
    return this.mounted.findIndex((e) => this.itemHasId(e.item, id));
  }

  /** Index of the in-flight optimistic/transient entry carrying the given clientMessageId — the reconcile key
   *  that pairs an optimistic send with its confirmed real (the real gets a fresh server id, so the pair cannot
   *  be matched by id). Scans transient/optimistic entries only; -1 if none / cid absent. */
  private indexOfClientMsgId(cid: string | undefined): number {
    if (cid === undefined) return -1;
    return this.mounted.findIndex(
      (e) => (e.transient || e.optimistic) && e.item.clientMessageId === cid,
    );
  }

  /** All clientMessageIds this real item fulfills — the head's singular clientMessageId, PLUS every album member's cid
   *  (clientMessageIds, set by the merge/absorb hooks when they combine same-creator IMAGE reals). Used to pair
   *  confirmed reals with their in-flight optimistic bubbles: an album confirms EVERY member's optimistic, not just the
   *  head's. Empty for a plain incoming/history message (no optimistic to reconcile). */
  private itemFulfilledCids(item: CbItem<T>): string[] {
    if (item.clientMessageIds) return item.clientMessageIds;
    return item.clientMessageId !== undefined ? [item.clientMessageId] : [];
  }

  /** Oldest mounted item id that is a real source member — skips transient inserts (insertAfter), optimistic sends
   *  (in-flight pending, not in the reloadable sequence), whose ids are not
   *  stable source cursors. Used by loadOlder so such an entry at mounted[0] doesn't make getOlder return [] and falsely
   *  lock noOlder. Callers guarantee mounted is non-empty. */
  private olderCursorId(): number {
    for (const e of this.mounted)
      if (!e.transient && !e.optimistic) return e.item.id;
    return this.mounted[0].item.id; // unreachable in practice (the insert/remove target is always a real neighbor)
  }

  /** Newest mounted item id that is a real source member — skips transient/optimistic inserts.
   *  Symmetric to olderCursorId. */
  private newerCursorId(): number {
    for (let i = this.mounted.length - 1; i >= 0; i--) {
      const e = this.mounted[i];
      if (!e.transient && !e.optimistic) {
        return e.item.ids?.at(-1) ?? e.item.id;
      }
    }
    const tail = this.mounted[this.mounted.length - 1].item;
    return tail.ids?.at(-1) ?? tail.id;
  }

  /** True when the scroller is at the live bottom with no newer unloaded history. */
  isPinnedToBottom(): boolean {
    return this.mounted.length > 0 && this.noNewer && this.isAtBottom();
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
    return (
      st < this.cfg.edge &&
      this.scrollDir(st) !== 'down' &&
      !(this.mounted.length <= 1 && this.noOlder)
    );
  }

  /** Revalidate: still at the bottom edge + direction not upward + newest boundary not hit. */
  private revalidateBottom(): boolean {
    const st = this.viewport.scrollTop;
    const total = this.totalH();
    return (
      total - this.vh - st < this.cfg.edge &&
      this.scrollDir(st) !== 'up' &&
      !this.noNewer
    );
  }

  private absorbBoundary(items: CbItem<T>[]): void {
    for (const it of items) {
      if (it.boundary === 'oldest' || it.boundary === 'both')
        this.noOlder = true;
      if (it.boundary === 'newest' || it.boundary === 'both')
        this.noNewer = true;
    }
  }

  /** Demote the former global-newest marker after a newer page proves that the sequence now continues past it. */
  private clearStaleNewestBoundary(): void {
    for (const entry of this.mounted) {
      if (entry.item.boundary === 'newest') {
        const { boundary: _boundary, ...item } = entry.item;
        entry.item = item;
      } else if (entry.item.boundary === 'both') {
        entry.item = { ...entry.item, boundary: 'oldest' };
      }
    }
  }

  private measureVh(): void {
    this.vh = this.viewport.clientHeight;
  }

  private onRegionResize(): void {
    if (this.inactive) return;
    const before = this.snapshotLayout();
    const oldReserve = this.bottomReserveH;
    const attached = this.captureComposerAnchor().mode === 'bottom';
    this.measurePending();
    const reserveDelta = this.bottomReserveH - oldReserve;
    if (this.arrivalWindowTimer !== null || this.animator.isRunning) {
      // Adjust the captured destination before clamping it to the new range.
      // Clamping first would count a reserve shrink twice.
      this.restoreLayout(before, attached || this.followIntent ? reserveDelta : 0);
    } else if (attached) {
      this.setVisualOffset(this.clampOffset(Infinity));
    } else {
      this.restoreLayout(before);
    }
    this.lastScrollTop = this.viewport.scrollTop;
    this.emit();
  }

  private measurePending(): void {
    if (this.hooks.updateTailPresentation) {
      const newest = this.noNewer
        ? selectHistoryEdges(this.mounted, (entry) => this.entrySeqs(entry.item).length > 0).newer?.item ?? null
        : null;
      const changed = new Set(this.hooks.updateTailPresentation(newest));
      for (const entry of this.mounted) {
        if (changed.has(entry.el) && !this.pendingMeasure.includes(entry))
          this.pendingMeasure.push(entry);
      }
    }
    this.bottomReserveH = this.bottomReserveView?.measure() ?? 0;
    if (this.pendingMeasure.length === 0) return;
    const entries = this.pendingMeasure;
    this.pendingMeasure = [];
    this.measuring = true;
    for (const entry of entries) {
      if (this.mounted.indexOf(entry) < 0) continue; // already unmounted (guards leftovers after trim)
      const h = entry.el.offsetHeight;
      this.commitMeasuredHeight(entry, h);
      entry.el.classList.remove('cb-pending');
    }
    this.measuring = false;
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
      if (sh > this.vh) {
        // min-height saturated → scrollHeight reflects true content height (valid independent check)
        const t = this.totalH();
        // The Angular shell keeps a top sentinel as a direct content child, while totalH deliberately models
        // only message rows + the kernel-owned tail cap. Include that structural height before judging drift;
        // otherwise the expected 1px sentinel consumes the entire tolerance and turns an ordinary rounding
        // seam into a false warning.
        const sentinel = this.content.querySelector<HTMLElement>(
          '.msg-sentinel, .pg-sentinel',
        );
        const expectedDomHeight = t + (sentinel?.offsetHeight ?? 0);
        const d = Math.round(expectedDomHeight - sh);
        if (Math.abs(d) > VS_DRIFT_TOLERANCE_PX) {
          console.warn('[vs.measure] height model drift', {
            model: expectedDomHeight,
            dom: sh,
            delta: d,
            viewport: this.vh,
            count: this.mounted.length,
          });
        }
      }
    }
  }

  private emit(): void {
    if (!this.inactive && this.pendingMeasure.length === 0) this.committedLayout = this.snapshotLayout();
    this.emitFullyVisibleEnter();
    this.onScroll?.(this.getInfo());
  }

  private fullyVisibleEntries(): Array<{ item: CbItem<T>; el: HTMLElement }> {
    const alignment = Math.max(0, this.vh - this.totalH());
    const indexes = this.mounted.flatMap((entry, index) => {
      const top = alignment + this.topOf(index) - this.visualOffset;
      return entry.height > 0 &&
        top >= -0.5 &&
        top + entry.height <= this.vh + 0.5
        ? [index]
        : [];
    });
    return indexes.flatMap((index) => {
      const entry = this.mounted[index];
      return entry && this.entrySeqs(entry.item).length > 0
        ? [{ item: entry.item, el: entry.el }]
        : [];
    });
  }

  getFullyVisibleIds(): number[] {
    return this.fullyVisibleEntries().flatMap(
      ({ item }) => item.ids ?? [item.id],
    );
  }

  private emitFullyVisibleEnter(): void {
    if (!this.onFullyVisibleEnter) return;
    const entries = this.fullyVisibleEntries();
    const current = new Set(entries.map(({ item }) => item.id));
    const entered = entries.filter(
      ({ item }) => !this.fullyVisibleIds.has(item.id),
    );
    this.fullyVisibleIds = current;
    if (entered.length > 0) this.onFullyVisibleEnter(entered);
  }
}
