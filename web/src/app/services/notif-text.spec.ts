import { buildAwayBody, AwayEntry } from './notif-text';

/**
 * buildAwayBody unit tests — the body text for the single rolling "away messages" summary notification.
 *
 * Pure: no Angular surface (mirrors `biz-code.spec` / `thread-delta.spec`). Transloco is an identity stub
 * that echoes the key + params, so we assert WHICH i18n key is selected AND the exact interpolations
 * passed (name / a / b / n / count) — not the bundle wording, which lives in en.json / zh-CN.json.
 */
const t = (key: string, params?: Record<string, unknown>): string =>
  `${key}:${params ? JSON.stringify(params) : ''}`;

function entry(name: string, count: number): AwayEntry {
  return { name, count };
}

describe('buildAwayBody', () => {
  it('returns null when there is nothing to summarize', () => {
    expect(buildAwayBody([], t)).toBeNull();
    // A thread present but zero messages (defensive — shouldn't happen, but never post an empty summary).
    expect(buildAwayBody([entry('Alice', 0)], t)).toBeNull();
  });

  it('one conversation, exactly one message → notif.one with the name', () => {
    expect(buildAwayBody([entry('Alice', 1)], t)).toBe('notif.one:{"name":"Alice"}');
  });

  it('one conversation, several messages → notif.many with name + count', () => {
    expect(buildAwayBody([entry('Alice', 5)], t)).toBe('notif.many:{"name":"Alice","count":5}');
  });

  it('two conversations → notif.two, count is the sum across both', () => {
    expect(buildAwayBody([entry('Alice', 2), entry('Bob', 3)], t)).toBe(
      'notif.two:{"a":"Alice","b":"Bob","count":5}',
    );
  });

  it('three conversations → notif.manyConv naming the first two + total conversation count', () => {
    const r = buildAwayBody([entry('Alice', 1), entry('Bob', 2), entry('Carol', 3)], t);
    expect(r).toBe('notif.manyConv:{"a":"Alice","b":"Bob","n":3,"count":6}');
  });

  it('four conversations → manyConv with n = conversation count (not "others")', () => {
    const r = buildAwayBody(
      [entry('Alice', 1), entry('Bob', 1), entry('Carol', 1), entry('Dave', 2)],
      t,
    );
    expect(r).toBe('notif.manyConv:{"a":"Alice","b":"Bob","n":4,"count":5}');
  });

  it('keeps insertion order for the named pair (first two threads to message win a / b)', () => {
    // Map iteration is insertion order, so the first conversation to receive a message is named first.
    const r = buildAwayBody([entry('Zoe', 1), entry('Amy', 1), entry('Bob', 1)], t);
    expect(r).toBe('notif.manyConv:{"a":"Zoe","b":"Amy","n":3,"count":3}');
  });
});
