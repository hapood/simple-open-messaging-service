import { describe, expect, it } from 'vitest';
import { rawBigInt, rawDate } from './raw-result.js';

describe('raw database result conversion', () => {
  it('normalizes timestamps returned by a raw SQL driver', () => {
    const date = new Date('2026-09-02T14:32:40.000Z');
    expect(rawDate(date.toISOString(), 'createdAt')).toEqual(date);
    expect(() => rawDate('invalid', 'createdAt')).toThrow(
      'createdAt is not a valid database timestamp',
    );
  });

  it('normalizes bigint values without accepting lossy numbers', () => {
    expect(rawBigInt('9007199254740993', 'id')).toBe(9007199254740993n);
    expect(() => rawBigInt('invalid', 'id')).toThrow(
      'id is not a valid database bigint',
    );
  });
});
