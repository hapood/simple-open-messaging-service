export type LocalCoverageState =
  | 'LOCAL_COVERED'
  | 'SERVER_PENDING'
  | 'SERVER_UNAVAILABLE';

export interface CoverageRange {
  readonly left: number;
  readonly right: number;
  readonly state: LocalCoverageState;
}

export type ProjectedGapItem =
  | { readonly kind: 'localGap'; readonly left: number; readonly right: number }
  | {
      readonly kind: 'serverGap';
      readonly left: number;
      readonly right: number;
      readonly state: 'SERVER_PENDING' | 'SERVER_UNAVAILABLE';
    };

export type ProjectedWindowItem<M extends { seq: number }> =
  | { readonly kind: 'message'; readonly message: M }
  | ProjectedGapItem;

export interface EntrySeamEvaluation {
  readonly ready: boolean;
  readonly empty: boolean;
  readonly olderReady: boolean;
  readonly newerReady: boolean;
}

function rangeCovering(
  ranges: readonly CoverageRange[],
  seq: number,
): CoverageRange | undefined {
  return ranges.find((r) => seq > r.left && seq <= r.right);
}

/**
 * Determine whether the frozen entry read-position seam is locally ready.
 *
 * - Older half includes `readSeq` (`R`); newer half excludes `R` (starts at `R + 1`).
 * - Confirmed `LOCAL_COVERED` (even if deleted) or `SERVER_UNAVAILABLE` satisfies coverage.
 * - Unknown coverage or `SERVER_PENDING` directly at the seam requires skeleton/special entry.
 * - Distant gaps outside the immediate seam do not block direct local entry.
 */
export function evaluateEntrySeam(params: {
  readSeq: number;
  knownEndSeq: number | null;
  ranges: readonly CoverageRange[];
  lowerBound?: number;
}): EntrySeamEvaluation {
  const { readSeq, knownEndSeq, ranges, lowerBound = 0 } = params;
  if (readSeq === 0 && knownEndSeq === 0) {
    return { ready: true, empty: true, olderReady: true, newerReady: true };
  }

  const olderNeeded = readSeq > lowerBound;
  const olderRange = olderNeeded ? rangeCovering(ranges, readSeq) : undefined;
  const olderReady =
    !olderNeeded ||
    (olderRange !== undefined && olderRange.state !== 'SERVER_PENDING');

  const newerNeeded = knownEndSeq === null || readSeq < knownEndSeq;
  const newerRange = newerNeeded
    ? rangeCovering(ranges, readSeq + 1)
    : undefined;
  const newerReady =
    !newerNeeded ||
    (newerRange !== undefined && newerRange.state !== 'SERVER_PENDING');

  return {
    ready: olderReady && newerReady,
    empty: false,
    olderReady,
    newerReady,
  };
}

/**
 * Project a bounded `(left, right]` interval from local coverage ranges and
 * cached messages into chronological messages, `serverGap`, and `localGap` items.
 * Never performs network I/O and never infers gaps from missing seq rows inside
 * a `LOCAL_COVERED` range.
 */
export function projectBoundedLocalInterval<M extends { seq: number }>(params: {
  left: number;
  right: number;
  ranges: readonly CoverageRange[];
  messages: readonly M[];
}): ProjectedWindowItem<M>[] {
  const { left, right, ranges, messages } = params;
  if (left >= right) return [];

  const clippedRanges = ranges
    .map((r) => ({
      left: Math.max(left, r.left),
      right: Math.min(right, r.right),
      state: r.state,
    }))
    .filter((r) => r.left < r.right)
    .sort((a, b) => a.left - b.left);

  const sortedMessages = messages
    .filter((m) => m.seq > left && m.seq <= right)
    .sort((a, b) => a.seq - b.seq);

  const raw: ProjectedWindowItem<M>[] = [];
  let cursor = left;

  const pushGap = (gap: ProjectedGapItem): void => {
    if (gap.left >= gap.right) return;
    const prev = raw[raw.length - 1];
    if (
      prev &&
      prev.kind === 'localGap' &&
      gap.kind === 'localGap' &&
      prev.right === gap.left
    ) {
      raw[raw.length - 1] = {
        kind: 'localGap',
        left: prev.left,
        right: gap.right,
      };
      return;
    }
    if (
      prev &&
      prev.kind === 'serverGap' &&
      gap.kind === 'serverGap' &&
      prev.state === gap.state &&
      prev.right === gap.left
    ) {
      raw[raw.length - 1] = {
        kind: 'serverGap',
        left: prev.left,
        right: gap.right,
        state: prev.state,
      };
      return;
    }
    raw.push(gap);
  };

  for (const range of clippedRanges) {
    if (range.left > cursor) {
      pushGap({ kind: 'localGap', left: cursor, right: range.left });
    }
    const segLeft = Math.max(cursor, range.left);
    if (segLeft < range.right) {
      if (range.state === 'LOCAL_COVERED') {
        for (const msg of sortedMessages) {
          if (msg.seq > segLeft && msg.seq <= range.right) {
            raw.push({ kind: 'message', message: msg });
          }
        }
      } else {
        pushGap({
          kind: 'serverGap',
          left: segLeft,
          right: range.right,
          state: range.state,
        });
      }
      cursor = range.right;
    }
  }

  if (cursor < right) {
    pushGap({ kind: 'localGap', left: cursor, right });
  }

  return raw;
}
