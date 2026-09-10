import { describe, expect, it } from 'vitest';
import {
  messageAdvanceInterval,
  readPositionInterval,
  type ThreadUnreadInterval,
} from './thread-feed-head.writer.js';

describe('exact thread unread intervals', () => {
  // Sparse facts include an own message and a tomb; deletion does not remove a slot.
  const facts = [
    { seq: 1, own: false, deleted: false },
    { seq: 3, own: true, deleted: false },
    { seq: 4, own: false, deleted: true },
    { seq: 7, own: false, deleted: false },
  ];
  const count = (read: number, end: number) =>
    facts.filter((m) => !m.own && m.seq > read && m.seq <= end).length;
  const delta = (value: ThreadUnreadInterval | null) =>
    value ? value.sign * count(value.afterSeq, value.throughSeq) : 0;

  it('matches full counts for every small read/end transition, including force', () => {
    for (let end = 0; end <= 9; end++) {
      for (let oldRead = 0; oldRead <= 9; oldRead++) {
        for (let nextRead = 0; nextRead <= 9; nextRead++) {
          expect(
            count(oldRead, end) +
              delta(readPositionInterval(oldRead, nextRead, end)),
          ).toBe(count(nextRead, end));
        }
        for (let target = 0; target <= 9; target++) {
          expect(
            count(oldRead, end) +
              delta(messageAdvanceInterval(oldRead, end, target)),
          ).toBe(count(oldRead, Math.max(end, target)));
        }
      }
    }
  });

  it('converges whether read or fanout executes first', () => {
    for (let oldRead = 0; oldRead <= 9; oldRead++) {
      for (let nextRead = 0; nextRead <= 9; nextRead++) {
        const initial = count(oldRead, 4);
        const readFirst =
          initial +
          delta(readPositionInterval(oldRead, nextRead, 4)) +
          delta(messageAdvanceInterval(nextRead, 4, 9));
        const fanoutFirst =
          initial +
          delta(messageAdvanceInterval(oldRead, 4, 9)) +
          delta(readPositionInterval(oldRead, nextRead, 9));
        expect(readFirst).toBe(count(nextRead, 9));
        expect(fanoutFirst).toBe(readFirst);
      }
    }
  });

  it('does not count tomb transitions twice or subtract unpublished slots', () => {
    expect(count(0, 4)).toBe(2);
    expect(readPositionInterval(4, 9, 4)).toBeNull();
    expect(messageAdvanceInterval(9, 4, 7)).toBeNull();
    expect(readPositionInterval(9, 7, 4)).toBeNull();
    expect(messageAdvanceInterval(0, 7, 4)).toBeNull();
  });

  it('does not impose a count or sequence cap of 100', () => {
    expect(messageAdvanceInterval(0, 0, 1000)).toEqual({
      afterSeq: 0,
      throughSeq: 1000,
      sign: 1,
    });
  });

  it.each([-1, 0.5, NaN, Infinity, 2_147_483_648])(
    'rejects invalid coordinate %s',
    (value) => {
      expect(() => messageAdvanceInterval(value, 0, 1)).toThrow(RangeError);
      expect(() => readPositionInterval(0, value, 1)).toThrow(RangeError);
    },
  );
});
