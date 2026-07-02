/**
 * Data source contract (CbSource): the isolation layer between the virtual-scroll kernel and "where the data
 * comes from".
 *
 * The kernel (ChatBoxScroller / ChatBoxScrollerAnchor) only manages window policy + rendering (array index-based:
 * an ordered `mounted[]` array where index 0 = oldest / DOM top → last = newest / bottom; the index is a
 * window-local index, non-cumulative, direction-agnostic, naturally bidirectional). It asks the data layer for
 * data through this interface; the data layer owns the cache + IO (HTTP / generator).
 *
 * [Source returns raw data only] The source returns **raw msgs** (`CbItem.id` = real msgId): it does NOT merge
 * albums and does NOT allocate display ids. Album merging is a presentation decision done by the kernel's
 * `mergeItems` hook (per-batch, before createItem). The source only handles IO + dedup (knownMsgIds, IO dedup) +
 * boundary markers.
 *
 * [Optimistic sends] In-flight optimistic sends live in a separate `pending` array (NOT in the reloadable
 * sequence). `getNewer` returns reals only, but reconciles pending — deleting any pending entry whose
 * clientMessageId matches a returned real (the confirm). The kernel mounts optimistic sends ONLY at the global
 * newest edge via `getPending()` (the dedicated accessor for the pending array). Symmetric lifecycle: when a
 * push lands a page that does not reach the newest (a large backlog), the kernel unmounts them; they re-mount
 * via `getPending()` once the newest is reached again. Pending ids are never valid `getOlder`/`getNewer` cursors
 * (they are not in the sequence), so the kernel's cursor derivation skips optimistic entries.
 *
 * [Cursors] When the kernel requests older/newer data it passes the boundary item's msgId as the cursor + a
 * direction + count (`getOlder(cursorId, count)` / `getNewer(cursorId, count)`). It does not rely on contiguous
 * numeric ids — kernel position (array index) and data id (msgId) are fully decoupled.
 *
 * [init anchor] init(anchorId, olderCount, newerCount):
 *  - `-1` = global newest (anchor = newest; newerCount ignored; out[last] is always 'newest'; first screen lays
 *    out from newest toward older).
 *  - other (string|number) = a real msgId: **bidirectional fetch** — olderCount older items (including anchorId)
 *    + newerCount newer items, returned as an ascending window centered on anchorId (used by jump-to-message /
 *    open-conversation-from-notification). Global oldest/newest are still marked by boundary.
 *
 * [Ascending convention] init / getOlder / getNewer all return **ascending** order (old→new): out[0] = oldest,
 * out[last] = newest. The kernel prepends (older) with `mounted = [...batch, ...mounted]` and appends (newer)
 * with `mounted = [...mounted, ...batch]`.
 *
 * [Cache belongs to the source] The kernel only holds "mounted CbElement"s; trim = forget; scrolling back =
 * re-getOlder/getNewer (source cache hit, near-synchronous return). The kernel has no "loaded range", only a
 * "mounted range".
 *
 * [Boundaries] The source tags the global oldest/newest item with a boundary marker; the kernel reads it to
 * self-maintain noOlder/noNewer.
 *  - getOlder reaching the DB oldest → out[0] (ascending first = oldest) carries 'oldest'
 *  - getNewer reaching the DB newest → out[last] (ascending last = newest) carries 'newest'
 *  - init: out[0] oldest (carries 'oldest' at the DB oldest), out[last] newest (always 'newest', anchor = newest)
 *
 * Framework-agnostic: does not import Angular/HTTP, only a type-only reference to CbItem (erased at compile time,
 * no runtime circular dependency).
 */
import type { CbItem } from './chat-box-scroller';

/** init business params (the production HTTP side needs chatId etc.; the mock ignores them. Extend with threadId etc. as needed). */
export interface CbSourceInitOpts {
  chatId?: number;
}

/**
 * The data source interface the kernel depends on (generic).
 *
 * `cursorId` is `CbItem.id` (= real msgId), taken by the kernel from the mounted window's boundary item. It is
 * only a source cursor and takes no part in kernel position arithmetic.
 */
export interface CbSource<T = unknown> {
  /**
   * Initialize / re-anchor: load olderCount older + newerCount newer items around anchorId.
   *  - anchorId: `-1` = global newest (newerCount ignored, out[last] always 'newest');
   *    other (string|number) = real msgId → bidirectional fetch (olderCount including anchorId + newerCount newer).
   * Returns raw msg items (ascending: old→new; CbItem.id = msgId; global oldest/newest carry boundary).
   * The kernel's init() uses -1 for the first screen; scrollToIndex(id)/init({startMsgId}) uses a real msgId.
   */
  init(anchorId: string | number, olderCount: number, newerCount: number, opts?: CbSourceInitOpts): Promise<CbItem<T>[]>;
  /**
   * Fetch `count` items **older** than cursorId (ascending; excludes cursor). Reaching the sequence start →
   * out[0] (oldest) carries boundary:'oldest'.
   */
  getOlder(cursorId: string | number, count: number): Promise<CbItem<T>[]>;
  /**
   * Fetch `count` items **newer** than cursorId (ascending; excludes cursor). Reaching the sequence end →
   * out[last] (newest) carries boundary:'newest'.
   *
   * [Reals only + pending reconcile] Returns real items only (never in-flight optimistic sends). As a side
   * effect, reconciles pending: any pending entry whose clientMessageId matches a returned real is deleted
   * (the confirm arrived). Optimistic sends are mounted separately at the newest edge via {@link getPending}.
   */
  getNewer(cursorId: string | number, count: number): Promise<CbItem<T>[]>;
  /**
   * Return the source's in-flight optimistic sends (the `pending` array) — the backing store that lets the kernel
   * (re)mount optimistic sends at the global newest edge. The kernel calls this once it has reached the newest (a
   * page carried boundary:'newest'), mounting any items not already mounted; it unmounts them when a push extends
   * the newest (a page without the marker) and re-fetches this on returning to the newest. Pending ids are not in
   * the reloadable sequence. Sources without optimistic sends implement this as `return []` (every source must
   * implement it — the kernel calls it unconditionally at the newest edge).
   */
  getPending(): CbItem<T>[];
  /**
   * Cache a live (WS-pushed) real message into the reloadable sequence. Cache-only — no merge, no core
   * notification, no return value; the kernel pulls it back via `getNewer` on the next signal. (Renamed from
   * `appendLive`, which previously returned shaped items for the kernel to mount directly; mounting now goes
   * through the signal → loadNewer path.)
   */
  pushLive(items: CbItem<T>[]): void;
  /** Tear down (unsubscribe WS, etc.). */
  destroy(): void;
}
