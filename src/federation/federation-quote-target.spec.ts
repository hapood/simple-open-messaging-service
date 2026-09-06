import { describe, expect, it } from 'vitest';
import {
  isFederationQuoteTarget,
  storeFederationQuote,
} from './federation-quote-target.js';

describe('federation quote coordinate contract', () => {
  it.each([{ seq: 8 }, { originSeq: 8 }])('accepts %j', (value) => {
    expect(isFederationQuoteTarget(value)).toBe(true);
  });
  it.each([
    {},
    { seq: 8, originSeq: 8 },
    { targetSeq: 8 },
    { seq: 0 },
    { seq: -1 },
    { originSeq: 1.5 },
    { seq: '8' },
    { seq: Number.MAX_SAFE_INTEGER + 1 },
    { seq: 8, namespaceId: 3 },
    [],
    false,
  ])('rejects %j', (value) => {
    expect(isFederationQuoteTarget(value)).toBe(false);
  });
  it('stores sender coordinates without checking existence or remapping the number', () => {
    expect(storeFederationQuote({ seq: 8 }, 12)).toEqual({
      seq: 8,
      namespaceId: 12,
    });
    expect(storeFederationQuote({ seq: 8 }, 19)).toEqual({
      seq: 8,
      namespaceId: 19,
    });
  });
  it('stores receiver coordinates as local references', () => {
    expect(storeFederationQuote({ originSeq: 42 }, 12)).toEqual({
      seq: 42,
      namespaceId: 0,
    });
  });
  it('rejects null rather than adding an availability state to the wire', () => {
    expect(isFederationQuoteTarget(null)).toBe(false);
  });
});
