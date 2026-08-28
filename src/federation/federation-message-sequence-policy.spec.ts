import { describe, expect, it } from 'vitest';
import { validatePreservedFederationOriginSequence } from './federation-message-sequence-policy.js';

describe('validatePreservedFederationOriginSequence', () => {
  it('accepts an origin coordinate inside the frozen reverse window', () => {
    expect(
      validatePreservedFederationOriginSequence(70, {
        kind: 'PRESERVE_ORIGIN',
        beforeSeq: 100,
        throughSeq: 40,
      }),
    ).toBe(70);
  });

  it('rejects the exclusive before coordinate', () => {
    expect(() =>
      validatePreservedFederationOriginSequence(100, {
        kind: 'PRESERVE_ORIGIN',
        beforeSeq: 100,
      }),
    ).toThrow('must be less than the reverse before cursor');
  });

  it('rejects a coordinate older than through', () => {
    expect(() =>
      validatePreservedFederationOriginSequence(39, {
        kind: 'PRESERVE_ORIGIN',
        beforeSeq: 100,
        throughSeq: 40,
      }),
    ).toThrow('must not precede the reverse through cursor');
  });
});
