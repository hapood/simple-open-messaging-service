export interface HistoryGapRange {
  left: number;
  right: number;
  state: 'SERVER_PENDING' | 'SERVER_UNAVAILABLE';
}

/**
 * Clips a persisted history gap `(left, right]` to the actual scanned range `(scanLeft, scanRight]`.
 * Persisted gaps in the database remain untouched; only the response payload is clipped.
 * Returns null if the gap does not intersect the scanned range.
 */
export function clipHistoryGapToScanRange<T extends HistoryGapRange>(
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

/**
 * Filters and clips a list of persisted gaps to the actual scanned range `(scanLeft, scanRight]`.
 */
export function clipHistoryGapsToScanRange<T extends HistoryGapRange>(
  gaps: readonly T[],
  scanLeft: number | null | undefined,
  scanRight: number | null | undefined,
): T[] {
  const result: T[] = [];
  for (const gap of gaps) {
    const clipped = clipHistoryGapToScanRange(gap, scanLeft, scanRight);
    if (clipped !== null) result.push(clipped);
  }
  return result;
}

function subtractRange<T extends HistoryGapRange>(
  gap: T,
  cutLeft: number,
  cutRight: number,
): T[] {
  if (cutRight <= gap.left || cutLeft >= gap.right) return [gap];
  const out: T[] = [];
  if (gap.left < cutLeft) out.push({ ...gap, right: cutLeft });
  if (cutRight < gap.right) out.push({ ...gap, left: cutRight });
  return out;
}

/**
 * Normalizes persisted gaps after a sync/fetch:
 * 1. Subtracts `resolvedRanges` (intervals confirmed to have complete messages).
 * 2. Applies `incomingGaps` (overriding overlapping portions of older gaps).
 * 3. Merges adjacent or overlapping gaps with the same state.
 */
export function mergeHistoryGaps<T extends HistoryGapRange>(
  existing: readonly T[],
  resolvedRanges: readonly { left: number; right: number }[],
  incomingGaps: readonly T[],
): T[] {
  let current: T[] = [...existing];

  for (const resolved of resolvedRanges) {
    if (resolved.left >= resolved.right) continue;
    current = current.flatMap((g) => subtractRange(g, resolved.left, resolved.right));
  }

  for (const incoming of incomingGaps) {
    if (incoming.left >= incoming.right) continue;
    current = current.flatMap((g) => subtractRange(g, incoming.left, incoming.right));
    current.push(incoming);
  }

  current.sort((a, b) => a.left - b.left || a.right - b.right);

  const merged: T[] = [];
  for (const gap of current) {
    const prev = merged[merged.length - 1];
    if (prev && prev.state === gap.state && gap.left <= prev.right) {
      prev.right = Math.max(prev.right, gap.right);
    } else {
      merged.push({ ...gap });
    }
  }
  return merged;
}
