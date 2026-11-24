import { describe, expect, it } from 'vitest';
import {
  clipServerGapToScanRange,
  splitServerGapByReadSeq,
  type ServerGapRange,
} from './gap-split';

describe('splitServerGapByReadSeq', () => {
  const gap: ServerGapRange = {
    left: 90,
    right: 110,
    state: 'SERVER_PENDING',
  };

  it('splits (90, 110] at readSeq=97 into (90, 97] and (97, 110]', () => {
    expect(splitServerGapByReadSeq(gap, 97)).toEqual([
      { left: 90, right: 97, state: 'SERVER_PENDING' },
      { left: 97, right: 110, state: 'SERVER_PENDING' },
    ]);
  });

  it('does not split when readSeq is at or outside gap bounds', () => {
    expect(splitServerGapByReadSeq(gap, 90)).toEqual([gap]);
    expect(splitServerGapByReadSeq(gap, 110)).toEqual([gap]);
    expect(splitServerGapByReadSeq(gap, 80)).toEqual([gap]);
    expect(splitServerGapByReadSeq(gap, 120)).toEqual([gap]);
    expect(splitServerGapByReadSeq(gap, null)).toEqual([gap]);
  });
});

describe('clipServerGapToScanRange', () => {
  const gap: ServerGapRange = {
    left: 90,
    right: 110,
    state: 'SERVER_UNAVAILABLE',
  };

  it('clips both ends when scan range falls strictly inside gap', () => {
    expect(clipServerGapToScanRange(gap, 95, 105)).toEqual({
      left: 95,
      right: 105,
      state: 'SERVER_UNAVAILABLE',
    });
  });

  it('clips only the bounded end when the other end is unbounded', () => {
    expect(clipServerGapToScanRange(gap, 95, null)).toEqual({
      left: 95,
      right: 110,
      state: 'SERVER_UNAVAILABLE',
    });
    expect(clipServerGapToScanRange(gap, null, 105)).toEqual({
      left: 90,
      right: 105,
      state: 'SERVER_UNAVAILABLE',
    });
  });

  it('returns null when scan range does not intersect gap', () => {
    expect(clipServerGapToScanRange(gap, 110, 120)).toBeNull();
    expect(clipServerGapToScanRange(gap, 70, 90)).toBeNull();
  });
});
