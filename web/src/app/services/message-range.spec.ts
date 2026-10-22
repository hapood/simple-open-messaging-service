import { describe, expect, it } from 'vitest';
import { reduceMessageRanges, type MessageRange } from './message-range';

const range = (
  left: number,
  right: number,
  state: MessageRange['state'],
): MessageRange => ({ threadId: 7, left, right, state });

describe('reduceMessageRanges', () => {
  it('uses cursor zero as the left-open origin', () => {
    expect(
      reduceMessageRanges({
        threadId: 7,
        current: [],
        scan: { left: 0, right: 1 },
        gaps: [],
        messageSeqs: [1],
      }),
    ).toEqual([range(0, 1, 'LOCAL_COVERED')]);
  });

  it('splits a successful scan around a pending backend gap', () => {
    expect(
      reduceMessageRanges({
        threadId: 7,
        current: [],
        scan: { left: 9, right: 50 },
        gaps: [{ left: 19, right: 30, state: 'SERVER_PENDING' }],
        messageSeqs: [10, 50],
      }),
    ).toEqual([
      range(9, 19, 'LOCAL_COVERED'),
      range(19, 30, 'SERVER_PENDING'),
      range(30, 50, 'LOCAL_COVERED'),
    ]);
  });

  it('shrinks pending when a later scan confirms its left portion', () => {
    expect(
      reduceMessageRanges({
        threadId: 7,
        current: [range(19, 30, 'SERVER_PENDING')],
        scan: { left: 19, right: 30 },
        gaps: [{ left: 25, right: 30, state: 'SERVER_PENDING' }],
        messageSeqs: [20, 25],
      }),
    ).toEqual([
      range(19, 25, 'LOCAL_COVERED'),
      range(25, 30, 'SERVER_PENDING'),
    ]);
  });

  it('does not let a stale larger pending gap overwrite local coverage', () => {
    expect(
      reduceMessageRanges({
        threadId: 7,
        current: [
          range(19, 25, 'LOCAL_COVERED'),
          range(25, 30, 'SERVER_PENDING'),
        ],
        scan: { left: 19, right: 30 },
        gaps: [{ left: 19, right: 30, state: 'SERVER_PENDING' }],
        messageSeqs: [],
      }),
    ).toEqual([
      range(19, 25, 'LOCAL_COVERED'),
      range(25, 30, 'SERVER_PENDING'),
    ]);
  });

  it('allows unavailable to replace pending but rejects its stale reversal', () => {
    const unavailable = reduceMessageRanges({
      threadId: 7,
      current: [range(19, 30, 'SERVER_PENDING')],
      scan: { left: 9, right: 50 },
      gaps: [{ left: 19, right: 30, state: 'SERVER_UNAVAILABLE' }],
      messageSeqs: [],
    });
    expect(unavailable).toEqual([
      range(9, 19, 'LOCAL_COVERED'),
      range(19, 30, 'SERVER_UNAVAILABLE'),
      range(30, 50, 'LOCAL_COVERED'),
    ]);
    expect(
      reduceMessageRanges({
        threadId: 7,
        current: unavailable,
        scan: { left: 9, right: 50 },
        gaps: [{ left: 19, right: 30, state: 'SERVER_PENDING' }],
        messageSeqs: [],
      }),
    ).toEqual(unavailable);
  });

  it('trusts complete returned gap boundaries beyond the scan', () => {
    expect(
      reduceMessageRanges({
        threadId: 7,
        current: [],
        scan: { left: 10, right: 20 },
        gaps: [{ left: 14, right: 35, state: 'SERVER_PENDING' }],
        messageSeqs: [11],
      }),
    ).toEqual([
      range(10, 14, 'LOCAL_COVERED'),
      range(14, 35, 'SERVER_PENDING'),
    ]);
  });

  it('merges only adjacent ranges with the same state', () => {
    expect(
      reduceMessageRanges({
        threadId: 7,
        current: [
          range(0, 10, 'LOCAL_COVERED'),
          range(10, 20, 'SERVER_PENDING'),
        ],
        scan: { left: 20, right: 30 },
        gaps: [{ left: 20, right: 30, state: 'SERVER_PENDING' }],
        messageSeqs: [],
      }),
    ).toEqual([range(0, 10, 'LOCAL_COVERED'), range(10, 30, 'SERVER_PENDING')]);
  });

  it.each([
    {
      name: 'overlapping current ranges',
      current: [range(0, 10, 'LOCAL_COVERED'), range(9, 20, 'SERVER_PENDING')],
      scan: { left: 20, right: 30 },
      gaps: [],
      messageSeqs: [],
    },
    {
      name: 'gap outside scan',
      current: [],
      scan: { left: 20, right: 30 },
      gaps: [{ left: 1, right: 10, state: 'SERVER_PENDING' as const }],
      messageSeqs: [],
    },
    {
      name: 'message inside gap',
      current: [],
      scan: { left: 10, right: 30 },
      gaps: [{ left: 19, right: 25, state: 'SERVER_PENDING' as const }],
      messageSeqs: [20],
    },
  ])('rejects $name', ({ current, scan, gaps, messageSeqs }) => {
    expect(() =>
      reduceMessageRanges({
        threadId: 7,
        current,
        scan,
        gaps,
        messageSeqs,
      }),
    ).toThrow();
  });
});
