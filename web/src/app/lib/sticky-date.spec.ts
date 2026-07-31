import {
  pickStickyDateLabel,
  stickyDateRowOpacity,
  isViewportTransformEnd,
  STICKY_DATE_PICK_FUZZ_PX,
  unreadDividerOverlapsStickyDate,
  type StickyDateRow,
} from './sticky-date';

describe('unreadDividerOverlapsStickyDate', () => {
  const visibleTop = 56;

  it('detects the first-render top anchor, where the unread divider starts at the visible top', () => {
    expect(
      unreadDividerOverlapsStickyDate({ top: 56, bottom: 94 }, visibleTop),
    ).toBeTrue();
  });

  it('does not hide the pill merely because the unread divider is visible lower in the viewport', () => {
    expect(
      unreadDividerOverlapsStickyDate({ top: 120, bottom: 158 }, visibleTop),
    ).toBeFalse();
  });

  it('uses strict interval bounds so touching either edge does not flicker the pill', () => {
    expect(
      unreadDividerOverlapsStickyDate({ top: 88, bottom: 126 }, visibleTop),
    ).toBeFalse();
    expect(
      unreadDividerOverlapsStickyDate({ top: 18, bottom: 62 }, visibleTop),
    ).toBeFalse();
  });

  it('detects partial overlap while the divider scrolls through the pill band', () => {
    expect(
      unreadDividerOverlapsStickyDate({ top: 80, bottom: 118 }, visibleTop),
    ).toBeTrue();
    expect(
      unreadDividerOverlapsStickyDate({ top: 30, bottom: 70 }, visibleTop),
    ).toBeTrue();
  });

  it('does not suppress the date when no unread divider is mounted', () => {
    expect(unreadDividerOverlapsStickyDate(null, visibleTop)).toBeFalse();
  });
});

describe('pickStickyDateLabel', () => {
  const rows = (entries: Array<[number, string | null]>): StickyDateRow[] =>
    entries.map(([top, label]) => ({ top, label }));

  it('returns the last date row at/above the visible top', () => {
    expect(
      pickStickyDateLabel(
        rows([
          [10, 'Mon'],
          [200, 'Tue'],
          [400, 'Wed'],
        ]),
        300,
        14,
      ),
    ).toBe('Tue');
  });

  it('returns null when no date row is at/above the visible top', () => {
    expect(pickStickyDateLabel(rows([[500, 'Mon']]), 300, 14)).toBeNull();
  });

  it('counts a row within `fuzz` below the visible top, but not beyond', () => {
    expect(pickStickyDateLabel(rows([[314, 'Mon']]), 300, 14)).toBe('Mon'); // 314 <= 300 + 14
    expect(pickStickyDateLabel(rows([[315, 'Mon']]), 300, 14)).toBeNull(); // 315 > 314
  });

  it('uses the floating pill top as the production handoff threshold', () => {
    expect(STICKY_DATE_PICK_FUZZ_PX).toBe(6);
    expect(
      pickStickyDateLabel(rows([[306, 'Mon']]), 300, STICKY_DATE_PICK_FUZZ_PX),
    ).toBe('Mon');
    expect(
      pickStickyDateLabel(rows([[307, 'Mon']]), 300, STICKY_DATE_PICK_FUZZ_PX),
    ).toBeNull();
  });

  it('skips null-label rows — a malformed empty row never clears the pill (last real date wins)', () => {
    expect(
      pickStickyDateLabel(
        rows([
          [10, null],
          [200, 'Tue'],
        ]),
        300,
        14,
      ),
    ).toBe('Tue');
    expect(
      pickStickyDateLabel(
        rows([
          [10, 'Mon'],
          [200, null],
          [300, 'Wed'],
        ]),
        500,
        14,
      ),
    ).toBe('Wed');
    expect(
      pickStickyDateLabel(
        rows([
          [10, 'Mon'],
          [200, null],
        ]),
        500,
        14,
      ),
    ).toBe('Mon'); // trailing null skipped
  });

  // The load-bearing scenario the user raised: a keyboard lift slides the viewport's own top UNDER the
  // header. The pill MUST key off the header bottom (stable visible top), not the translated viewport top.
  describe('keyboard-lift invariant (visible top = header bottom, not viewport top)', () => {
    // Header bottom (the stable visible top) = 56. The keyboard lifts the viewport by K=300, so the
    // viewport's getBoundingClientRect().top = 56 − 300 = −244 (under the header). Date rows translate with
    // the viewport: "Yesterday" (was at 56, the visible top) is now at −244 (hidden behind the header);
    // "Today" (was 300px below, at 356) is now at 56 (the new visible top).
    const visibleTop = 56; // header bottom — the correct baseline
    const viewportTop = -244; // the OLD (buggy) baseline — the viewport's translated top
    const liftedRows: StickyDateRow[] = [
      { top: -244, label: 'Yesterday' }, // now hidden under the header
      { top: 56, label: 'Today' }, // now at the visible top
    ];

    it('keys off the header bottom → picks the now-visible date', () => {
      expect(pickStickyDateLabel(liftedRows, visibleTop, 14)).toBe('Today');
    });

    it('keying off the translated viewport top would pick the hidden date (the bug this replaces)', () => {
      // Documents WHY visibleTop must be the header bottom: the viewport top has slid under the header, so
      // a viewport-top baseline selects the hidden "Yesterday" instead of the visible "Today".
      expect(pickStickyDateLabel(liftedRows, viewportTop, 14)).toBe(
        'Yesterday',
      );
    });
  });
});

describe('stickyDateRowOpacity', () => {
  const fadeLo = 100;
  const fadeHi = 146; // 46px band

  it('is fully transparent at/below fadeLo when the float is shown', () => {
    expect(stickyDateRowOpacity(50, fadeLo, fadeHi, true)).toBe(0);
    expect(stickyDateRowOpacity(100, fadeLo, fadeHi, true)).toBe(0);
  });

  it('is fully opaque above fadeHi (or when no float is shown)', () => {
    expect(stickyDateRowOpacity(146, fadeLo, fadeHi, true)).toBe(1);
    expect(stickyDateRowOpacity(200, fadeLo, fadeHi, true)).toBe(1);
    expect(stickyDateRowOpacity(50, fadeLo, fadeHi, false)).toBe(1); // no float → always opaque
  });

  it('interpolates linearly across the fade band', () => {
    expect(stickyDateRowOpacity(123, fadeLo, fadeHi, true)).toBeCloseTo(0.5, 5); // (123−100)/46 ≈ 0.5
  });
});

describe('isViewportTransformEnd', () => {
  const viewport = {} as HTMLElement;
  const child = {} as HTMLElement;

  it("is true for the viewport's own transform transition", () => {
    expect(
      isViewportTransformEnd(
        { target: viewport, propertyName: 'transform' },
        viewport,
      ),
    ).toBe(true);
  });

  it('is false for a bubbled item transition (target is a child, not the viewport)', () => {
    expect(
      isViewportTransformEnd(
        { target: child, propertyName: 'transform' },
        viewport,
      ),
    ).toBe(false);
  });

  it('is false for a non-transform property on the viewport', () => {
    expect(
      isViewportTransformEnd(
        { target: viewport, propertyName: 'opacity' },
        viewport,
      ),
    ).toBe(false);
  });
});
