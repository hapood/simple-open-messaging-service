import { describe, expect, it } from 'vitest';
import {
  calculatePublisherReservationOffset,
  mapFederationOriginSequence,
} from './federation-message-sequence-policy.js';

describe('calculatePublisherReservationOffset', () => {
  it.each([0, 10])(
    'initializes without an anchor after local tail %i',
    (curSeq) => {
      expect(
        calculatePublisherReservationOffset({
          firstOriginSeq: 1,
          curSeq,
        }),
      ).toBe(curSeq);
    },
  );

  it('computes curSeq + 1 - firstOriginSeq without an extra slot', () => {
    const offset = calculatePublisherReservationOffset({
      firstOriginSeq: 101,
      curSeq: 111,
    });
    expect(offset).toBe(11);
    expect(101 + offset).toBe(112);
    expect(102 + offset).toBe(113);
  });

  it('rejects negative offsets rather than clamping them', () => {
    expect(() =>
      calculatePublisherReservationOffset({
        firstOriginSeq: 101,
        curSeq: 50,
      }),
    ).toThrow('non-negative');
  });
});

describe('mapFederationOriginSequence', () => {
  it('maps an origin coordinate inside the frozen reverse window', () => {
    expect(
      mapFederationOriginSequence(70, {
        kind: 'MAP_ORIGIN',
        beforeSeq: 100,
        throughSeq: 40,
        messageSeqOffset: 7,
      }),
    ).toBe(77);
  });

  it('rejects the exclusive before coordinate', () => {
    expect(() =>
      mapFederationOriginSequence(100, {
        kind: 'MAP_ORIGIN',
        beforeSeq: 100,
        messageSeqOffset: 0,
      }),
    ).toThrow('must be less than the reverse before cursor');
  });

  it('rejects a coordinate older than through', () => {
    expect(() =>
      mapFederationOriginSequence(39, {
        kind: 'MAP_ORIGIN',
        beforeSeq: 100,
        throughSeq: 40,
        messageSeqOffset: 0,
      }),
    ).toThrow('must not precede the reverse through cursor');
  });
});
