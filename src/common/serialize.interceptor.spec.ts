import { serializeBody } from './serialize.interceptor';

describe('serializeBody', () => {
  it('BigInt → string', () => {
    expect(serializeBody(9007199254740993n)).toBe('9007199254740993');
  });

  it('Date → 毫秒时间戳 (number)', () => {
    const d = new Date('2026-06-24T00:00:00Z');
    expect(serializeBody(d)).toBe(d.getTime());
    expect(typeof serializeBody(new Date(0))).toBe('number');
  });

  it('原语原样返回（含 null/undefined）', () => {
    expect(serializeBody(42)).toBe(42);
    expect(serializeBody('hi')).toBe('hi');
    expect(serializeBody(true)).toBe(true);
    expect(serializeBody(null)).toBeNull();
    expect(serializeBody(undefined)).toBeUndefined();
  });

  it('嵌套对象递归转换', () => {
    const input = { id: 1n, nested: { id: 2n, d: new Date(0) } };
    expect(serializeBody(input)).toEqual({
      id: '1',
      nested: { id: '2', d: 0 },
    });
  });

  it('数组递归转换', () => {
    const input = [{ id: 1n }, { id: 2n }];
    expect(serializeBody(input)).toEqual([{ id: '1' }, { id: '2' }]);
  });

  it('lastRead (BigInt?) 转 string，null 保留 —— 堵原 convertBigIntId 漏转的 500', () => {
    expect(serializeBody({ lastRead: 5n })).toEqual({ lastRead: '5' });
    expect(serializeBody({ lastRead: null })).toEqual({ lastRead: null });
  });

  it('Message 形状（id BigInt + createdAt Date）整体转换', () => {
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

  it('返回新对象，不修改原对象', () => {
    const input = { id: 1n };
    serializeBody(input);
    expect(input.id).toBe(1n); // 原对象 BigInt 未被就地改写
  });

  it('循环引用不爆栈（命中 seen 返回原引用）', () => {
    const a: { id: bigint; self?: unknown } = { id: 1n };
    a.self = a;
    const out = serializeBody(a) as { id: string; self: unknown };
    expect(out.id).toBe('1');
    expect(out.self).toBe(a); // 循环点返回原引用
  });

  it('类实例 / Map / Buffer 原样返回（不遍历）', () => {
    class Foo {
      x = 1n;
    }
    const foo = new Foo();
    expect(serializeBody(foo)).toBe(foo); // 同一引用，未遍历

    const m = new Map([['k', 1n]]);
    expect(serializeBody(m)).toBe(m);
  });
});
