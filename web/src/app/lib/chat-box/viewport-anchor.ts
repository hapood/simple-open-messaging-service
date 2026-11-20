/** Capture before mutation, except pinLatest which resolves after mounting/measurement. */
export type WindowPositionScenario =
  | { kind: 'olderDelivery' }
  | { kind: 'newerDelivery' }
  | { kind: 'entryDelivery' }
  | { kind: 'pendingUpdate' }
  | { kind: 'gapReplacement'; suffixId: number }
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
