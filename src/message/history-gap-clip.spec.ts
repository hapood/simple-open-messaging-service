import { describe, expect, it } from 'vitest';
import {
  clipHistoryGapToScanRange,
  clipHistoryGapsToScanRange,
  mergeHistoryGaps,
  type HistoryGapRange,
} from './history-gap-clip';

describe('history-gap-clip', () => {
  const gaps: HistoryGapRange[] = [
    { left: 10, right: 30, state: 'SERVER_UNAVAILABLE' },
    { left: 90, right: 110, state: 'SERVER_PENDING' },
    { left: 200, right: 220, state: 'SERVER_PENDING' },
  ];

  it('clips a single gap strictly to the scanned range', () => {
    expect(clipHistoryGapToScanRange(gaps[1], 95, 105)).toEqual({
      left: 95,
      right: 105,
      state: 'SERVER_PENDING',
    });
    expect(clipHistoryGapToScanRange(gaps[1], null, 105)).toEqual({
      left: 90,
      right: 105,
      state: 'SERVER_PENDING',
    });
    expect(clipHistoryGapToScanRange(gaps[1], 95, null)).toEqual({
      left: 95,
      right: 110,
      state: 'SERVER_PENDING',
    });
  });

  it('filters and clips a list of persisted gaps without mutating originals', () => {
    const clipped = clipHistoryGapsToScanRange(gaps, 25, 100);
    expect(clipped).toEqual([
      { left: 25, right: 30, state: 'SERVER_UNAVAILABLE' },
      { left: 90, right: 100, state: 'SERVER_PENDING' },
    ]);
    expect(gaps[0]).toEqual({ left: 10, right: 30, state: 'SERVER_UNAVAILABLE' });
    expect(gaps[1]).toEqual({ left: 90, right: 110, state: 'SERVER_PENDING' });
  });

  it('splits existing gaps on resolved ranges, overrides states, and merges adjacent same-state gaps', () => {
    const existing: HistoryGapRange[] = [
      { left: 90, right: 110, state: 'SERVER_PENDING' },
    ];
    const afterResolve = mergeHistoryGaps(existing, [{ left: 95, right: 100 }], []);
    expect(afterResolve).toEqual([
      { left: 90, right: 95, state: 'SERVER_PENDING' },
      { left: 100, right: 110, state: 'SERVER_PENDING' },
    ]);

    const afterMerge = mergeHistoryGaps(
      afterResolve,
      [],
      [
        { left: 95, right: 100, state: 'SERVER_PENDING' },
        { left: 105, right: 115, state: 'SERVER_UNAVAILABLE' },
      ],
    );
    expect(afterMerge).toEqual([
      { left: 90, right: 105, state: 'SERVER_PENDING' },
      { left: 105, right: 115, state: 'SERVER_UNAVAILABLE' },
    ]);
  });
});
