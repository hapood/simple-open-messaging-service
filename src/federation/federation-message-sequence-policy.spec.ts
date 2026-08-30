import { describe, expect, it } from 'vitest';
import { mapFederationOriginSequence } from './federation-message-sequence-policy.js';

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
