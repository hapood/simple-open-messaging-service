/** Capture before mutation, except pinLatest which resolves after mounting/measurement. */
export type WindowPositionScenario =
  | { kind: 'olderDelivery' }
  | { kind: 'newerDelivery' }
  | { kind: 'pendingUpdate' }
  | { kind: 'viewportResize' }
  | { kind: 'preserveReading' }
  | { kind: 'goToLatest' }
  | { kind: 'pinLatest' };

export type ViewportAnchor =
  | { mode: 'bottom' }
  | { mode: 'offset'; offset: number }
  | {
      mode: 'message-bottom';
      id: number;
      offset: number;
      fallbackId: number | null;
    }
  | { mode: 'item'; id: number; offset: number; fallbackId: number | null };

export function alignedItemOffset(
  itemHeight: number,
  viewportHeight: number,
  alignment: 'top' | 'center' | 'bottom',
): number {
  if (alignment === 'center') return itemHeight / 2 - viewportHeight / 2;
  if (alignment === 'bottom') return itemHeight - viewportHeight;
  return 0;
}

export function clampScrollTop(
  target: number,
  scrollHeight: number,
  viewportHeight: number,
): number {
  return Math.max(0, Math.min(target, scrollHeight - viewportHeight));
}

/**
 * Distance from an item's vertical span `[itemTop, itemTop + itemHeight]` to the
 * viewport's vertical center (`viewportScrollTop + viewportHeight / 2`).
 * Returns `0` when the item straddles the viewport center, otherwise the shortest
 * distance from the item's nearest edge to the viewport center.
 */
export function distanceToViewportCenter(
  itemTop: number,
  itemHeight: number,
  viewportScrollTop: number,
  viewportHeight: number,
): number {
  const center = viewportScrollTop + viewportHeight / 2;
  const bottom = itemTop + Math.max(0, itemHeight);
  if (center < itemTop) return itemTop - center;
  if (center > bottom) return center - bottom;
  return 0;
}

export interface ViewportCenterMatch {
  readonly index: number;
  readonly top: number;
  readonly height: number;
  /** Offset of the item's top edge relative to the viewport top (`top - viewportScrollTop`). */
  readonly offset: number;
  /** Shortest vertical distance from the item to the viewport center (`0` when straddling center). */
  readonly distance: number;
}

/**
 * Find the mounted item straddling (or closest to) the viewport's vertical center.
 * Ties prefer the newer (larger index) item. Returns `null` when `count === 0`.
 */
export function findViewportCenterItem(
  count: number,
  topOf: (index: number) => number,
  heightOf: (index: number) => number,
  viewportScrollTop: number,
  viewportHeight: number,
): ViewportCenterMatch | null {
  if (count <= 0) return null;
  let best: ViewportCenterMatch | null = null;
  for (let i = 0; i < count; i++) {
    const top = topOf(i);
    const height = heightOf(i);
    const distance = distanceToViewportCenter(
      top,
      height,
      viewportScrollTop,
      viewportHeight,
    );
    if (best === null || distance <= best.distance) {
      best = {
        index: i,
        top,
        height,
        offset: top - viewportScrollTop,
        distance,
      };
    }
  }
  return best;
}
