import { describe, expect, it, vi } from 'vitest';
import { KeyedProjectionScheduler } from './keyed-projection-scheduler';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function flush() {
  for (let index = 0; index < 8; index++) await Promise.resolve();
}

function fixture(concurrency?: number) {
  const reads: Array<{
    key: string;
    result: ReturnType<typeof deferred<number | undefined>>;
  }> = [];
  const read = vi.fn((key: string) => {
    const result = deferred<number | undefined>();
    reads.push({ key, result });
    return result.promise;
  });
  const publish = vi.fn();
  const onError = vi.fn();
  const scheduler = new KeyedProjectionScheduler({
    read,
    publish,
    onError,
    concurrency,
  });
  return { scheduler, reads, read, publish, onError };
}

// State assertions also guard against retaining retired keys indefinitely.
function laneCount(scheduler: unknown): number {
  return (scheduler as { lanes: Map<unknown, unknown> }).lanes.size;
}

describe('KeyedProjectionScheduler', () => {
  it('coalesces a synchronous burst before dispatch and settles every caller', async () => {
    const { scheduler, read, reads, publish } = fixture();
    const completions = Array.from({ length: 20 }, () =>
      scheduler.request('a'),
    );
    expect(read).not.toHaveBeenCalled();
    await flush();
    expect(read).toHaveBeenCalledTimes(1);
    reads[0].result.resolve(1);
    await Promise.all(completions);
    expect(publish).toHaveBeenCalledExactlyOnceWith('a', 1);
    expect(laneCount(scheduler)).toBe(0);
  });

  it('limits global concurrency to four by default', async () => {
    const { scheduler, reads } = fixture();
    const completions = ['a', 'b', 'c', 'd', 'e', 'f'].map((key) =>
      scheduler.request(key),
    );
    await flush();
    expect(reads.map(({ key }) => key)).toEqual(['a', 'b', 'c', 'd']);
    reads[1].result.resolve(2);
    await flush();
    expect(reads.map(({ key }) => key)).toEqual(['a', 'b', 'c', 'd', 'e']);
    reads[0].result.resolve(1);
    await flush();
    expect(reads).toHaveLength(6);
    for (const { result } of reads) result.resolve(3);
    await Promise.all(completions);
  });

  it('honors custom concurrency and puts trailing work behind queued keys', async () => {
    const { scheduler, reads, publish } = fixture(1);
    const first = scheduler.request('a');
    await flush();
    const second = scheduler.request('b');
    const trailing = scheduler.request('a');
    reads[0].result.resolve(1);
    await flush();
    expect(reads.map(({ key }) => key)).toEqual(['a', 'b']);
    expect(publish).not.toHaveBeenCalled();
    reads[1].result.resolve(2);
    await second;
    await flush();
    expect(reads.map(({ key }) => key)).toEqual(['a', 'b', 'a']);
    reads[2].result.resolve(3);
    await Promise.all([first, trailing]);
    expect(publish.mock.calls).toEqual([
      ['b', 2],
      ['a', 3],
    ]);
  });

  it('skips intermediate results and reads the latest owner facts on each trailing pass', async () => {
    let ownerFact = 1;
    const gates: Array<ReturnType<typeof deferred<void>>> = [];
    const publish = vi.fn();
    const read = vi.fn(async () => {
      const fact = ownerFact;
      const gate = deferred<void>();
      gates.push(gate);
      await gate.promise;
      return fact;
    });
    const scheduler = new KeyedProjectionScheduler({ read, publish });
    let settled = false;
    const first = scheduler.request('a').then(() => (settled = true));
    await flush();
    ownerFact = 2;
    const second = scheduler.request('a');
    const third = scheduler.request('a');
    gates[0].resolve();
    await flush();
    expect(read).toHaveBeenCalledTimes(2);
    expect(settled).toBe(false);
    expect(publish).not.toHaveBeenCalled();
    ownerFact = 3;
    const fourth = scheduler.request('a');
    gates[1].resolve();
    await flush();
    expect(publish).not.toHaveBeenCalled();
    gates[2].resolve();
    await Promise.all([first, second, third, fourth]);
    expect(publish).toHaveBeenCalledExactlyOnceWith('a', 3);
  });

  it('lets an independent key publish while another key remains blocked', async () => {
    const { scheduler, reads, publish } = fixture();
    const slow = scheduler.request('slow');
    const fast = scheduler.request('fast');
    await flush();
    reads[1].result.resolve(2);
    await fast;
    expect(publish).toHaveBeenCalledExactlyOnceWith('fast', 2);
    reads[0].result.resolve(1);
    await slow;
  });

  it('has no settlement gap for a request immediately after await', async () => {
    const read = vi.fn(async () => 1);
    const publish = vi.fn();
    const scheduler = new KeyedProjectionScheduler({ read, publish });
    for (let index = 0; index < 20; index++) await scheduler.request('a');
    expect(read).toHaveBeenCalledTimes(20);
    expect(publish).toHaveBeenCalledTimes(20);
    expect(laneCount(scheduler)).toBe(0);
  });

  it('does not publish undefined and retires the successful lane', async () => {
    const { scheduler, reads, publish } = fixture();
    const completion = scheduler.request('a');
    await flush();
    reads[0].result.resolve(undefined);
    await completion;
    expect(publish).not.toHaveBeenCalled();
    expect(laneCount(scheduler)).toBe(0);
  });

  it('parks a failed lane without retrying and reactivates on the next request', async () => {
    const { scheduler, reads, onError, publish } = fixture();
    const error = new Error('read failed');
    const completion = scheduler.request('a');
    await flush();
    reads[0].result.reject(error);
    await completion;
    await flush();
    expect(reads).toHaveLength(1);
    expect(onError).toHaveBeenCalledExactlyOnceWith('a', error);
    expect(publish).not.toHaveBeenCalled();
    expect(laneCount(scheduler)).toBe(1);
    const retry = scheduler.request('a');
    await flush();
    reads[1].result.resolve(2);
    await retry;
    expect(publish).toHaveBeenCalledExactlyOnceWith('a', 2);
    expect(laneCount(scheduler)).toBe(0);
  });

  it('settles failed callers but consumes demand recorded during the failed read', async () => {
    const { scheduler, reads, publish } = fixture();
    const first = scheduler.request('a');
    await flush();
    const second = scheduler.request('a');
    reads[0].result.reject(new Error('stale failed read'));
    await Promise.all([first, second]);
    await flush();
    expect(reads).toHaveLength(2);
    reads[1].result.resolve(2);
    await flush();
    expect(publish).toHaveBeenCalledExactlyOnceWith('a', 2);
    expect(laneCount(scheduler)).toBe(0);
  });

  it('parks after a trailing failure instead of hot-looping', async () => {
    const { scheduler, reads } = fixture();
    const first = scheduler.request('a');
    await flush();
    const second = scheduler.request('a');
    reads[0].result.reject(new Error('first failure'));
    await Promise.all([first, second]);
    await flush();
    reads[1].result.reject(new Error('trailing failure'));
    await flush();
    expect(reads).toHaveLength(2);
    scheduler.invalidate('a');
    expect(laneCount(scheduler)).toBe(0);
  });

  it('contains synchronous read and error observer exceptions', async () => {
    const error = new Error('sync read');
    const read = vi.fn((): Promise<number> => {
      throw error;
    });
    const onError = vi.fn(() => {
      throw new Error('observer failed');
    });
    const scheduler = new KeyedProjectionScheduler({
      read,
      publish: vi.fn(),
      onError,
    });
    await scheduler.request('a');
    await flush();
    expect(read).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledExactlyOnceWith('a', error);
    await scheduler.request('a');
    expect(read).toHaveBeenCalledTimes(2);
    scheduler.destroy();
  });

  it('cancels queued demand on invalidate and allows a fresh request', async () => {
    const { scheduler, reads, publish } = fixture(1);
    const blocker = scheduler.request('blocker');
    await flush();
    const canceled = scheduler.request('a');
    scheduler.invalidate('a');
    await canceled;
    const fresh = scheduler.request('a');
    reads[0].result.resolve(1);
    await blocker;
    await flush();
    expect(reads.map(({ key }) => key)).toEqual(['blocker', 'a']);
    reads[1].result.resolve(2);
    await fresh;
    expect(publish.mock.calls).toEqual([
      ['blocker', 1],
      ['a', 2],
    ]);
  });

  it('invalidates before dispatch without doing any work', async () => {
    const { scheduler, read } = fixture();
    const completion = scheduler.request('a');
    scheduler.invalidate('a');
    await completion;
    await flush();
    expect(read).not.toHaveBeenCalled();
    expect(laneCount(scheduler)).toBe(0);
  });

  it('serializes fresh requests behind an invalidated in-flight read', async () => {
    const { scheduler, reads, publish } = fixture();
    const old = scheduler.request('a');
    await flush();
    const oldTrailing = scheduler.request('a');
    scheduler.invalidate('a');
    await Promise.all([old, oldTrailing]);
    const canceledFresh = scheduler.request('a');
    scheduler.invalidate('a');
    await canceledFresh;
    let freshSettled = false;
    const fresh = scheduler.request('a').then(() => (freshSettled = true));
    await flush();
    expect(reads).toHaveLength(1);
    expect(freshSettled).toBe(false);
    reads[0].result.resolve(1);
    await flush();
    expect(publish).not.toHaveBeenCalled();
    expect(reads).toHaveLength(2);
    expect(freshSettled).toBe(false);
    reads[1].result.resolve(2);
    await fresh;
    expect(publish).toHaveBeenCalledExactlyOnceWith('a', 2);
  });

  it('keeps the global concurrency slot occupied after invalidation', async () => {
    const { scheduler, reads, publish } = fixture(1);
    const old = scheduler.request('a');
    await flush();
    scheduler.invalidate('a');
    await old;
    const other = scheduler.request('b');
    await flush();
    expect(reads).toHaveLength(1);
    reads[0].result.resolve(1);
    await flush();
    expect(reads.map(({ key }) => key)).toEqual(['a', 'b']);
    reads[1].result.resolve(2);
    await other;
    expect(publish).toHaveBeenCalledExactlyOnceWith('b', 2);
  });

  it('ignores obsolete errors without settling or parking fresh demand', async () => {
    const { scheduler, reads, onError } = fixture();
    const old = scheduler.request('a');
    await flush();
    scheduler.invalidate('a');
    await old;
    let settled = false;
    const fresh = scheduler.request('a').then(() => (settled = true));
    reads[0].result.reject(new Error('obsolete'));
    await flush();
    expect(onError).not.toHaveBeenCalled();
    expect(settled).toBe(false);
    expect(reads).toHaveLength(2);
    reads[1].result.resolve(2);
    await fresh;
    expect(laneCount(scheduler)).toBe(0);
  });

  it('retires an invalidated running lane after its read finishes', async () => {
    const { scheduler, reads, publish } = fixture();
    const completion = scheduler.request('a');
    await flush();
    scheduler.invalidate('a');
    await completion;
    expect(laneCount(scheduler)).toBe(1);
    reads[0].result.resolve(1);
    await flush();
    expect(publish).not.toHaveBeenCalled();
    expect(laneCount(scheduler)).toBe(0);
  });

  it('destroys queued and running demand and suppresses late success and errors', async () => {
    const { scheduler, reads, publish, onError } = fixture(2);
    const completions = ['a', 'b', 'c'].map((key) => scheduler.request(key));
    await flush();
    scheduler.destroy();
    scheduler.destroy();
    await Promise.all(completions);
    expect(laneCount(scheduler)).toBe(0);
    reads[0].result.resolve(1);
    reads[1].result.reject(new Error('late'));
    await scheduler.request('a');
    scheduler.invalidate('a');
    await flush();
    expect(reads).toHaveLength(2);
    expect(publish).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it('destroys before the dispatch microtask runs', async () => {
    const { scheduler, read } = fixture();
    const completion = scheduler.request('a');
    scheduler.destroy();
    await completion;
    await flush();
    expect(read).not.toHaveBeenCalled();
  });

  it('preserves requests made reentrantly by synchronous publication', async () => {
    const read = vi.fn(async () => read.mock.calls.length);
    let trailing: Promise<void> | undefined;
    const publish = vi.fn(() => {
      if (publish.mock.calls.length === 1) trailing = scheduler.request('a');
    });
    const scheduler: KeyedProjectionScheduler<string, number> =
      new KeyedProjectionScheduler({ read, publish });
    await scheduler.request('a');
    await trailing;
    expect(publish.mock.calls).toHaveLength(2);
    expect(read).toHaveBeenCalledTimes(2);
    expect(laneCount(scheduler)).toBe(0);
  });

  it('handles invalidate and re-request reentrantly during publication', async () => {
    const read = vi.fn(async () => 1);
    let fresh: Promise<void> | undefined;
    const publish = vi.fn(() => {
      if (publish.mock.calls.length === 1) {
        scheduler.invalidate('a');
        fresh = scheduler.request('a');
      }
    });
    const scheduler: KeyedProjectionScheduler<string, number> =
      new KeyedProjectionScheduler({ read, publish });
    await scheduler.request('a');
    await fresh;
    expect(read).toHaveBeenCalledTimes(2);
    expect(laneCount(scheduler)).toBe(0);
  });

  it('handles destruction during publication without dispatching queued work', async () => {
    const read = vi.fn(async () => 1);
    const publish = vi.fn(() => scheduler.destroy());
    const scheduler: KeyedProjectionScheduler<string, number> =
      new KeyedProjectionScheduler({ read, publish, concurrency: 1 });
    await Promise.all([scheduler.request('a'), scheduler.request('b')]);
    expect(read).toHaveBeenCalledTimes(1);
    expect(laneCount(scheduler)).toBe(0);
  });

  it('contains publication exceptions and permits explicit retry', async () => {
    const error = new Error('publication failed');
    const publish = vi.fn<() => void>(() => {
      throw error;
    });
    const onError = vi.fn();
    const scheduler = new KeyedProjectionScheduler({
      read: async () => 1,
      publish,
      onError,
    });
    await scheduler.request('a');
    await flush();
    expect(publish).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledExactlyOnceWith('a', error);
    publish.mockImplementation(() => {});
    await scheduler.request('a');
    expect(publish).toHaveBeenCalledTimes(2);
    expect(laneCount(scheduler)).toBe(0);
  });

  it('preserves fresh requests made by the error observer', async () => {
    const read = vi.fn<() => Promise<number>>();
    read.mockRejectedValueOnce(new Error('first')).mockResolvedValue(2);
    let retry: Promise<void> | undefined;
    const onError = vi.fn(() => {
      scheduler.invalidate('a');
      retry = scheduler.request('a');
    });
    const publish = vi.fn();
    const scheduler: KeyedProjectionScheduler<string, number> =
      new KeyedProjectionScheduler({ read, publish, onError });
    await scheduler.request('a');
    await retry;
    expect(read).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenCalledExactlyOnceWith('a', 2);
    expect(laneCount(scheduler)).toBe(0);
  });

  it('supports undefined and object keys with Map identity semantics', async () => {
    const read = vi.fn(async () => 1);
    const publish = vi.fn();
    const scheduler = new KeyedProjectionScheduler<object | undefined, number>({
      read,
      publish,
    });
    const key = {};
    await Promise.all([
      scheduler.request(undefined),
      scheduler.request(key),
      scheduler.request(key),
      scheduler.request({}),
    ]);
    expect(read).toHaveBeenCalledTimes(3);
    expect(publish).toHaveBeenCalledTimes(3);
    expect(laneCount(scheduler)).toBe(0);
  });

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid concurrency %s',
    (concurrency) => {
      expect(() => fixture(concurrency)).toThrow(RangeError);
    },
  );
});
