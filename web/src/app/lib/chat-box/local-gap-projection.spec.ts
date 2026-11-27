import { describe, expect, it } from 'vitest';
import {
  evaluateEntrySeam,
  projectBoundedLocalInterval,
  type CoverageRange,
} from './local-gap-projection';

describe('evaluateEntrySeam', () => {
  it('treats known R=0, E=0 as immediately ready empty conversation', () => {
    expect(
      evaluateEntrySeam({ readSeq: 0, knownEndSeq: 0, ranges: [] }),
    ).toEqual({
      ready: true,
      empty: true,
      olderReady: true,
      newerReady: true,
    });
  });

  it('requires coverage at R+1 when R=0 and E>0 or unknown', () => {
    expect(
      evaluateEntrySeam({ readSeq: 0, knownEndSeq: 10, ranges: [] }),
    ).toEqual({
      ready: false,
      empty: false,
      olderReady: true,
      newerReady: false,
    });
    expect(
      evaluateEntrySeam({ readSeq: 0, knownEndSeq: null, ranges: [] }),
    ).toEqual({
      ready: false,
      empty: false,
      olderReady: true,
      newerReady: false,
    });
  });

  it('checks 100 on the older side and 101 on the newer side for R=100, ignoring distant gaps', () => {
    const ranges: CoverageRange[] = [
      { left: 95, right: 105, state: 'LOCAL_COVERED' },
      { left: 0, right: 50, state: 'SERVER_PENDING' },
      { left: 200, right: 250, state: 'SERVER_PENDING' },
    ];
    expect(
      evaluateEntrySeam({ readSeq: 100, knownEndSeq: 250, ranges }),
    ).toEqual({
      ready: true,
      empty: false,
      olderReady: true,
      newerReady: true,
    });
  });

  it('marks seam not ready when either 100 or 101 is unknown or SERVER_PENDING', () => {
    // 100 covered, 101 unknown
    expect(
      evaluateEntrySeam({
        readSeq: 100,
        knownEndSeq: 250,
        ranges: [{ left: 50, right: 100, state: 'LOCAL_COVERED' }],
      }),
    ).toEqual({
      ready: false,
      empty: false,
      olderReady: true,
      newerReady: false,
    });

    // 100 SERVER_PENDING, 101 covered
    expect(
      evaluateEntrySeam({
        readSeq: 100,
        knownEndSeq: 250,
        ranges: [
          { left: 90, right: 100, state: 'SERVER_PENDING' },
          { left: 100, right: 120, state: 'LOCAL_COVERED' },
        ],
      }),
    ).toEqual({
      ready: false,
      empty: false,
      olderReady: false,
      newerReady: true,
    });
  });

  it('accepts confirmed ceiling (R === E) and SERVER_UNAVAILABLE at the seam', () => {
    expect(
      evaluateEntrySeam({
        readSeq: 100,
        knownEndSeq: 100,
        ranges: [{ left: 90, right: 100, state: 'LOCAL_COVERED' }],
      }),
    ).toEqual({
      ready: true,
      empty: false,
      olderReady: true,
      newerReady: true,
    });

    expect(
      evaluateEntrySeam({
        readSeq: 100,
        knownEndSeq: 200,
        ranges: [
          { left: 90, right: 100, state: 'LOCAL_COVERED' },
          { left: 100, right: 110, state: 'SERVER_UNAVAILABLE' },
        ],
      }),
    ).toEqual({
      ready: true,
      empty: false,
      olderReady: true,
      newerReady: true,
    });
  });
});

describe('projectBoundedLocalInterval', () => {
  it('projects disconnected cached islands with localGap and serverGap without fabricating gaps for deleted seqs', () => {
    const items = projectBoundedLocalInterval({
      left: 0,
      right: 100,
      ranges: [
        { left: 10, right: 30, state: 'LOCAL_COVERED' },
        { left: 40, right: 60, state: 'SERVER_PENDING' },
        { left: 60, right: 70, state: 'SERVER_PENDING' },
        { left: 80, right: 90, state: 'SERVER_UNAVAILABLE' },
      ],
      // seq 11..29 missing inside LOCAL_COVERED (10, 30] are deleted, not gaps
      messages: [{ seq: 15 }, { seq: 25 }, { seq: 99 }],
    });

    expect(items).toEqual([
      { kind: 'localGap', left: 0, right: 10 },
      { kind: 'message', message: { seq: 15 } },
      { kind: 'message', message: { seq: 25 } },
      { kind: 'localGap', left: 30, right: 40 },
      { kind: 'serverGap', left: 40, right: 70, state: 'SERVER_PENDING' },
      { kind: 'localGap', left: 70, right: 80 },
      { kind: 'serverGap', left: 80, right: 90, state: 'SERVER_UNAVAILABLE' },
      { kind: 'localGap', left: 90, right: 100 },
    ]);
  });

  it('clips ranges to the requested window bounds', () => {
    const items = projectBoundedLocalInterval({
      left: 50,
      right: 75,
      ranges: [
        { left: 0, right: 60, state: 'LOCAL_COVERED' },
        { left: 65, right: 100, state: 'SERVER_UNAVAILABLE' },
      ],
      messages: [{ seq: 40 }, { seq: 55 }, { seq: 80 }],
    });
    expect(items).toEqual([
      { kind: 'message', message: { seq: 55 } },
      { kind: 'localGap', left: 60, right: 65 },
      { kind: 'serverGap', left: 65, right: 75, state: 'SERVER_UNAVAILABLE' },
    ]);
  });
});
