import { describe, expect, it } from 'vitest';
import {
  forwardBundleStorageReference,
  parseForwardBundleStorageReference,
} from './forward-bundle-storage-reference.js';

describe('private forward bundle bigint references', () => {
  it.each([1n, 9_007_199_254_740_993n, 9_223_372_036_854_775_807n])(
    'round trips %s through JSON without number conversion',
    (id) => {
      const stored = JSON.parse(
        JSON.stringify({ childBundleId: forwardBundleStorageReference(id) }),
      );
      expect(parseForwardBundleStorageReference(stored.childBundleId)).toBe(id);
    },
  );
  it.each([
    '0',
    '-1',
    '01',
    '1.5',
    '1e3',
    '01m52j5fx906ht7t6ww5ysc7a0',
    'a'.repeat(64),
    '9223372036854775808',
  ])('rejects invalid or nonlocal reference %s', (value) => {
    expect(() => parseForwardBundleStorageReference(value)).toThrow();
  });
  it.each([0n, -1n, 9_223_372_036_854_775_808n])(
    'rejects out-of-range database id %s',
    (id) => {
      expect(() => forwardBundleStorageReference(id)).toThrow();
    },
  );
});
