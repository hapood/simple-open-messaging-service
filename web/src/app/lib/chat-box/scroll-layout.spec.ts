import { describe, expect, it } from 'vitest';
import {
  captureScrollLayout,
  compensateScrollLayout,
  ScrollLayoutRow,
  ScrollLayoutSnapshot,
  visualOffsetOf,
} from './scroll-layout';

function row(
  ids: readonly number[],
  top: number,
  height = 40,
  tailHeight = 0,
): ScrollLayoutRow {
  return { ids, top, height, tailHeight };
}

function layout(
  rows: readonly ScrollLayoutRow[],
  overrides: Partial<ScrollLayoutSnapshot> = {},
): ScrollLayoutSnapshot {
  return captureScrollLayout({
    rows,
    viewportHeight: 200,
    scrollTop: 300,
    translateY: 0,
    totalHeight: 1000,
    ...overrides,
  });
}

describe('captureScrollLayout', () => {
  it('copies and freezes every level without freezing caller-owned data', () => {
    const ids = [1, 2];
    const sourceRow = { ids, top: 30, height: 60, tailHeight: 10 };
    const source = {
      rows: [sourceRow],
      viewportHeight: 200,
      scrollTop: 300,
      translateY: 20,
      totalHeight: 1000,
      targetOffset: 500,
    };
    const snapshot = captureScrollLayout(source);
    ids.push(3);
    sourceRow.top = 80;
    source.rows.length = 0;
    source.targetOffset = 600;
    expect(snapshot.rows).toEqual([row([1, 2], 30, 60, 10)]);
    expect(snapshot.targetOffset).toBe(500);
    expect(visualOffsetOf(snapshot)).toBe(280);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.rows)).toBe(true);
    expect(Object.isFrozen(snapshot.rows[0])).toBe(true);
    expect(Object.isFrozen(snapshot.rows[0].ids)).toBe(true);
    expect(Object.isFrozen(sourceRow)).toBe(false);
  });
});

describe('compensateScrollLayout', () => {
  it.each([
    ['merge', [row([1], 300), row([2], 380)], [row([1, 2], 330)], 250],
    ['changed album head', [row([1, 2], 380)], [row([2, 3], 420)], 340],
    ['split', [row([1, 2], 380)], [row([2], 450), row([1], 350)], 270],
    [
      'reorder',
      [row([1], 300), row([2], 380)],
      [row([2], 100), row([1], 500)],
      20,
    ],
    [
      'removed center row',
      [row([1], 300), row([2], 380), row([3], 470)],
      [row([1], 280), row([3], 450)],
      280,
    ],
    ['prepend', [row([1], 380)], [row([0], 0), row([1], 480)], 400],
  ] as const)(
    'preserves member identity through %s',
    (_name, before, after, expected) => {
      expect(compensateScrollLayout(layout(before), layout(after))).toBe(
        expected,
      );
    },
  );

  it('uses the closest surviving span, not the row midpoint', () => {
    const before = layout([row([1], 0, 450), row([2], 450)]);
    expect(
      compensateScrollLayout(
        before,
        layout([row([1], 20, 450), row([2], 600)]),
      ),
    ).toBe(320);
  });

  it('prefers the earlier old row on an equal-distance tie, preserving existing anchor selection', () => {
    expect(
      compensateScrollLayout(
        layout([row([1], 340), row([2], 420)]),
        layout([row([1], 100), row([2], 500)]),
      ),
    ).toBe(60);
  });

  it('preserves actual screen position through an active transform', () => {
    const before = layout([row([1], 380)], { translateY: 30 });
    const after = layout([row([1], 450)], { translateY: -80 });
    const offset = compensateScrollLayout(before, after)!;
    expect(offset).toBe(340);
    expect(after.rows[0].top - offset).toBe(
      before.rows[0].top - visualOffsetOf(before),
    );
  });

  it('preserves short bottom-aligned content without prematurely clamping', () => {
    const before = layout([row([1], 140, 60)], {
      scrollTop: 0,
      totalHeight: 200,
    });
    const after = layout([row([1], 100, 100)], {
      scrollTop: 0,
      totalHeight: 200,
    });
    expect(compensateScrollLayout(before, after)).toBe(-40);
  });

  it('returns null when no IDs survive, including empty and presentation-only rows', () => {
    expect(
      compensateScrollLayout(layout([row([1], 380)]), layout([row([2], 380)])),
    ).toBeNull();
    expect(compensateScrollLayout(layout([]), layout([]))).toBeNull();
    expect(
      compensateScrollLayout(layout([row([], 380)]), layout([row([], 380)])),
    ).toBeNull();
  });
});
