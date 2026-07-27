import { describe, it, expect } from 'vitest';
import { of } from 'rxjs';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { SerializeInterceptor, serializeBody } from './serialize.interceptor.js';
import { envelope, type ApiResult } from './api-result.js';
import { BusinessCode } from './business-code.js';

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

/** Build an interceptor whose Reflector returns a fixed `isRaw` for any handler/class scan. */
function makeInterceptor(isRaw: boolean): SerializeInterceptor {
  const reflector = { getAllAndOverride: () => isRaw } as unknown as Reflector;
  return new SerializeInterceptor(reflector);
}

/** A stub ExecutionContext — getHandler/getClass values are irrelevant since Reflector is stubbed. */
const ctx = {
  getHandler: () => ({}),
  getClass: () => ({}),
} as unknown as ExecutionContext;

/** Run the interceptor against `data` and return the synchronous mapped output. */
function run(ic: SerializeInterceptor, data: unknown): unknown {
  let out: unknown;
  ic
    .intercept(ctx, { handle: () => of(data) } as CallHandler)
    .subscribe((v) => (out = v));
  return out;
}

/**
 * SerializeInterceptor now wraps the ApiResult envelope around raw handler returns. Phase A behavior:
 * raw payload → wrapped; pre-built envelope literal → passed through (compat, no double-wrap); `envelope()`
 * carrier → unwrapped + merged; `@Raw` → no wrap (serializeBody only).
 */
describe('SerializeInterceptor — envelope wrapping', () => {
  it('wraps raw payload data in the ApiResult envelope', () => {
    const out = run(makeInterceptor(false), { id: 7, name: 'x' }) as ApiResult;
    expect(out.code).toBe(BusinessCode.OK);
    expect(out.message).toBe('successful');
    expect(out.data).toEqual({ id: 7, name: 'x' });
  });

  it('passes a pre-built envelope through unchanged (compat — no double-wrap)', () => {
    const prebuilt = {
      code: BusinessCode.OK,
      message: 'successful',
      data: { a: 1 },
      hasMore: false,
    };
    expect(run(makeInterceptor(false), prebuilt)).toEqual(prebuilt);
  });

  it('unwraps an envelope() carrier, merging messageKey/hasMore', () => {
    const out = run(
      makeInterceptor(false),
      envelope({ a: 1 }, { messageKey: 'friend.msg.sent', hasMore: true }),
    ) as ApiResult;
    expect(out.code).toBe(BusinessCode.OK);
    expect(out.message).toBe('successful');
    expect(out.data).toEqual({ a: 1 });
    expect(out.messageKey).toBe('friend.msg.sent');
    expect(out.hasMore).toBe(true);
  });

  it('does NOT wrap a @Raw handler return — serializeBody only', () => {
    // Absent code/message = no envelope; BigInt → string proves serializeBody still ran.
    const out = run(makeInterceptor(true), { domain: 'x', count: BigInt(5) }) as Record<
      string,
      unknown
    >;
    expect(out.code).toBeUndefined();
    expect(out.message).toBeUndefined();
    expect(out.domain).toBe('x');
    expect(out.count).toBe('5');
  });

  it('serializes BigInt/Date inside a wrapped envelope', () => {
    const out = run(makeInterceptor(false), { id: BigInt(9), at: new Date(0) }) as ApiResult;
    expect((out.data as Record<string, unknown>).id).toBe('9');
    expect((out.data as Record<string, unknown>).at).toBe(0);
  });

  it('returns undefined unchanged (e.g. a void 204 handler)', () => {
    expect(run(makeInterceptor(false), undefined)).toBeUndefined();
  });
});
