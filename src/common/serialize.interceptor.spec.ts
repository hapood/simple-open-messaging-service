import { describe, it, expect } from 'vitest';
import { serializeBody } from './serialize.interceptor.js';

describe('serializeBody', () => {
  it('BigInt → string', () => {
    expect(serializeBody(9007199254740993n)).toBe('9007199254740993');
  });

  it('Date → millisecond timestamp (number)', () => {
    const d = new Date('2026-06-24T00:00:00Z');
    expect(serializeBody(d)).toBe(d.getTime());
    expect(typeof serializeBody(new Date(0))).toBe('number');
  });

  it('primitives returned as-is (including null/undefined)', () => {
    expect(serializeBody(42)).toBe(42);
    expect(serializeBody('hi')).toBe('hi');
    expect(serializeBody(true)).toBe(true);
    expect(serializeBody(null)).toBeNull();
    expect(serializeBody(undefined)).toBeUndefined();
  });

  it('nested objects are recursively converted', () => {
    const input = { id: 1n, nested: { id: 2n, d: new Date(0) } };
    expect(serializeBody(input)).toEqual({
      id: '1',
      nested: { id: '2', d: 0 },
    });
  });

  it('arrays are recursively converted', () => {
    const input = [{ id: 1n }, { id: 2n }];
    expect(serializeBody(input)).toEqual([{ id: '1' }, { id: '2' }]);
  });

  it('lastRead (BigInt?) converts to string, null preserved — fixes the 500 caused by old convertBigIntId missing conversion', () => {
    expect(serializeBody({ lastRead: 5n })).toEqual({ lastRead: '5' });
    expect(serializeBody({ lastRead: null })).toEqual({ lastRead: null });
  });

  it('Message shape (id BigInt + createdAt Date) converted as a whole', () => {
    const input = {
      id: 9007199254740993n,
      contentType: 'PURE_TEXT',
      content: 'hi',
      threadId: 12,
      creator: 1,
      createdAt: new Date(1_700_000_000_000),
    };
    expect(serializeBody(input)).toEqual({
      id: '9007199254740993',
      contentType: 'PURE_TEXT',
      content: 'hi',
      threadId: 12,
      creator: 1,
      createdAt: 1_700_000_000_000,
    });
  });

  it('returns a new object, does not modify the original', () => {
    const input = { id: 1n };
    serializeBody(input);
    expect(input.id).toBe(1n); // the original object's BigInt was not mutated in place
  });

  it('circular references do not overflow the stack (hits seen and returns the original reference)', () => {
    const a: { id: bigint; self?: unknown } = { id: 1n };
    a.self = a;
    const out = serializeBody(a) as { id: string; self: unknown };
    expect(out.id).toBe('1');
    expect(out.self).toBe(a); // the circular point returns the original reference
  });

  it('class instances / Map / Buffer returned as-is (not traversed)', () => {
    class Foo {
      x = 1n;
    }
    const foo = new Foo();
    expect(serializeBody(foo)).toBe(foo); // same reference, not traversed

    const m = new Map([['k', 1n]]);
    expect(serializeBody(m)).toBe(m);
  });
});
