export type ViewportAnchor =
  | { mode: 'bottom' }
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

export function clampScrollTop(target: number, scrollHeight: number, viewportHeight: number): number {
  return Math.max(0, Math.min(target, scrollHeight - viewportHeight));
}
