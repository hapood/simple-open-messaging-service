export type ViewportAnchor =
  | { mode: 'bottom' }
  | { mode: 'offset'; offset: number }
  | { mode: 'item'; id: number; offset: number; fallbackId: number | null };

/** Explicit alignment is used only when placing a newly loaded window. */
export function alignedItemOffset(
  itemHeight: number,
  viewportHeight: number,
  alignment: 'top' | 'center' | 'bottom',
): number {
  if (alignment === 'center') return itemHeight / 2 - viewportHeight / 2;
  if (alignment === 'bottom') return itemHeight - viewportHeight;
  return 0;
}

/** Distance from a row's span to the viewport center; zero when they overlap. */
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
