export interface ServerGapRange {
  left: number;
  right: number;
  state: 'SERVER_PENDING' | 'SERVER_UNAVAILABLE';
}

/**
 * Splits a persisted gap `(left, right]` into two display segments when `readSeq`
 * falls strictly inside `(left, right)`:
 *   1. `(left, readSeq]` (before the unread divider)
 *   2. `(readSeq, right]` (after the unread divider)
 *
 * Persisted storage keeps the original unsplit gap; only the presentation layer splits it.
 */
export function splitServerGapByReadSeq<T extends ServerGapRange>(
  gap: T,
  readSeq: number | null | undefined,
): T[] {
  if (
    readSeq === null ||
    readSeq === undefined ||
    !Number.isFinite(readSeq) ||
    readSeq <= gap.left ||
    readSeq >= gap.right
  ) {
    return [gap];
  }
  return [
    { ...gap, left: gap.left, right: readSeq },
    { ...gap, left: readSeq, right: gap.right },
  ];
}

/**
 * Clips a persisted gap `(left, right]` to the actual scanned range `(scanLeft, scanRight]`.
 * Returns null if the gap does not intersect the scanned range.
 *
 * - If `scanLeft` is provided and falls inside `(left, right)`, the left end is clipped to `scanLeft`.
 * - If `scanRight` is provided and falls inside `(left, right)`, the right end is clipped to `scanRight`.
 * - Unbounded ends (`null`/`undefined`) do not clip the corresponding side of the gap.
 */
export function clipServerGapToScanRange<T extends ServerGapRange>(
  gap: T,
  scanLeft: number | null | undefined,
  scanRight: number | null | undefined,
): T | null {
  const left =
    scanLeft !== null && scanLeft !== undefined ? Math.max(gap.left, scanLeft) : gap.left;
  const right =
    scanRight !== null && scanRight !== undefined ? Math.min(gap.right, scanRight) : gap.right;
  if (left >= right) return null;
  if (left === gap.left && right === gap.right) return gap;
  return { ...gap, left, right };
}
