import { describe, expect, it } from 'vitest';
import { continuousCoverageEnd } from './peer-key-coverage.js';

const DAY = 86_400_000;
const T0 = 1_700_000_000_000;

describe('continuousCoverageEnd', () => {
  it('covers through the single interval containing now', () => {
    expect(
      continuousCoverageEnd(
        [{ notBefore: T0, notAfter: T0 + 30 * DAY }],
        T0 + DAY,
      ),
    ).toBe(T0 + 30 * DAY);
  });

  it('extends across overlapping and abutting successor intervals', () => {
    expect(
      continuousCoverageEnd(
        [
          { notBefore: T0, notAfter: T0 + 30 * DAY },
          { notBefore: T0 + 30 * DAY, notAfter: T0 + 60 * DAY },
          { notBefore: T0 + 50 * DAY, notAfter: T0 + 90 * DAY },
        ],
        T0 + DAY,
      ),
    ).toBe(T0 + 90 * DAY);
  });

  it('stops at a gap even when a later interval reaches further', () => {
    // Design-doc example: [Jan 1, Jan 31) + [Feb 1, Mar 1) covers only Jan 31.
    expect(
      continuousCoverageEnd(
        [
          { notBefore: T0, notAfter: T0 + 30 * DAY },
          { notBefore: T0 + 31 * DAY, notAfter: T0 + 60 * DAY },
        ],
        T0 + DAY,
      ),
    ).toBe(T0 + 30 * DAY);
  });

  it('ignores fully expired intervals and returns null when nothing covers now', () => {
    expect(
      continuousCoverageEnd(
        [
          { notBefore: T0 - 10 * DAY, notAfter: T0 - DAY },
          { notBefore: T0 + 5 * DAY, notAfter: T0 + 30 * DAY },
        ],
        T0,
      ),
    ).toBeNull();
  });

  it('starts coverage from the interval covering now, not the earliest listed', () => {
    expect(
      continuousCoverageEnd(
        [
          { notBefore: T0 + DAY, notAfter: T0 + 2 * DAY },
          { notBefore: T0, notAfter: T0 + 30 * DAY },
        ],
        T0 + DAY,
      ),
    ).toBe(T0 + 30 * DAY);
  });

  it('returns null for an empty set', () => {
    expect(continuousCoverageEnd([], T0)).toBeNull();
  });

  it('treats the intervals as half-open at both ends', () => {
    expect(
      continuousCoverageEnd([{ notBefore: T0, notAfter: T0 + DAY }], T0),
    ).toBe(T0 + DAY);
    expect(
      continuousCoverageEnd([{ notBefore: T0, notAfter: T0 + DAY }], T0 + DAY),
    ).toBeNull();
  });
});
