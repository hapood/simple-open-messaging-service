import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BusinessCode } from '../common/business-code.js';
import {
  FederationTransportError,
  S2sResponseError,
} from './federation-errors.js';
import {
  FederationHttpScheduler,
  isRetryableFederationNetworkError,
} from './federation-http-scheduler.js';

function scheduler(global: number, perPeer: number) {
  const instance = new FederationHttpScheduler({} as never);
  Object.assign(instance as unknown as Record<string, unknown>, {
    limits: { global, perPeer },
    limitsFetchedAt: Date.now(),
  });
  return instance;
}

beforeEach(() => {
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('FederationHttpScheduler', () => {
  it('rejects queued and new requests, and drains active slots without pumping', async () => {
    const subject = scheduler(1, 1);
    const release = await subject.acquire('first');
    const queued = expect(subject.acquire('second')).rejects.toThrow(
      'federation HTTP scheduler shutting down',
    );
    await Promise.resolve();
    subject.onModuleDestroy();
    await queued;
    await expect(subject.acquire('third')).rejects.toThrow(
      'federation HTTP scheduler shutting down',
    );
    let closed = false;
    const closing = subject.beforeApplicationShutdown().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    release();
    release();
    await closing;
  });

  it('cancels a queued slot waiter immediately when its signal aborts', async () => {
    const subject = scheduler(1, 1);
    const release = await subject.acquire('a.example');
    const controller = new AbortController();
    const queued = subject.acquire('a.example', controller.signal);
    await Promise.resolve();
    controller.abort(new Error('caller cancelled'));
    await expect(queued).rejects.toThrow('caller cancelled');
    release();
    const next = await subject.acquire('a.example');
    next();
    await subject.beforeApplicationShutdown();
  });

  it.each([false, true])(
    'drains a limits query without late admission (failure: %s)',
    async (fails) => {
      let resolve!: (rows: unknown[]) => void;
      let reject!: (error: Error) => void;
      const findMany = vi.fn(
        () =>
          new Promise((res, rej) => {
            resolve = res;
            reject = rej;
          }),
      );
      const subject = new FederationHttpScheduler({
        db: { query: { systemSetting: { findMany } } },
      } as never);
      const failure = new Error('limits query failed');
      const work = expect(subject.acquire('peer')).rejects.toThrow(
        fails ? failure.message : 'federation HTTP scheduler shutting down',
      );
      let closed = false;
      const closing = subject.beforeApplicationShutdown().finally(() => {
        closed = true;
      });
      const result = fails
        ? expect(closing).rejects.toMatchObject({ errors: [failure] })
        : expect(closing).resolves.toBeUndefined();
      await Promise.resolve();
      expect(closed).toBe(false);
      subject.invalidateLimits();
      if (fails) reject(failure);
      else resolve([]);
      await work;
      await result;
      expect(findMany).toHaveBeenCalledOnce();
    },
  );

  it('retries a failed limits query instead of caching its failure', async () => {
    const failure = new Error('limits unavailable');
    const findMany = vi
      .fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce([]);
    const subject = new FederationHttpScheduler({
      db: { query: { systemSetting: { findMany } } },
    } as never);
    await expect(subject.acquire('peer')).rejects.toBe(failure);
    const release = await subject.acquire('peer');
    release();
    expect(findMany).toHaveBeenCalledTimes(2);
  });

  it('waits at the global and per-peer limits, then releases exactly one waiter', async () => {
    const subject = scheduler(3, 2);
    const releases = await Promise.all([
      subject.acquire('a.example'),
      subject.acquire('a.example'),
      subject.acquire('b.example'),
    ]);
    let aStarted = false;
    let bStarted = false;
    const queuedA = subject.acquire('a.example').then((release) => {
      aStarted = true;
      return release;
    });
    const queuedB = subject.acquire('b.example').then((release) => {
      bStarted = true;
      return release;
    });
    await Promise.resolve();
    expect(aStarted).toBe(false);
    expect(bStarted).toBe(false);

    releases[2]();
    const releaseB = await queuedB;
    expect(bStarted).toBe(true);
    expect(aStarted).toBe(false);

    releases[0]();
    const releaseA = await queuedA;
    expect(aStarted).toBe(true);
    releases[1]();
    releaseA();
    releaseB();
  });

  it('round-robins peers while retaining FIFO order within one peer', async () => {
    const subject = scheduler(1, 1);
    const first = await subject.acquire('a.example');
    const order: string[] = [];
    let releaseA1: (() => void) | undefined;
    let releaseA2: (() => void) | undefined;
    let releaseB1: (() => void) | undefined;
    void subject.acquire('a.example').then((release) => {
      order.push('a1');
      releaseA1 = release;
    });
    void subject.acquire('a.example').then((release) => {
      order.push('a2');
      releaseA2 = release;
    });
    void subject.acquire('b.example').then((release) => {
      order.push('b1');
      releaseB1 = release;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    first();
    await vi.waitFor(() => expect(order).toEqual(['a1']));
    releaseA1!();
    await vi.waitFor(() => expect(order).toEqual(['a1', 'b1']));
    releaseB1!();
    await vi.waitFor(() => expect(order).toEqual(['a1', 'b1', 'a2']));
    releaseA2!();
  });

  it('makes release idempotent', async () => {
    const subject = scheduler(1, 1);
    const release = await subject.acquire('a.example');
    release();
    release();
    const next = await subject.acquire('b.example');
    next();
  });

  it('classifies retryable federation network errors', () => {
    expect(
      isRetryableFederationNetworkError(
        new FederationTransportError('timeout'),
      ),
    ).toBe(true);
    expect(
      isRetryableFederationNetworkError(
        new S2sResponseError('busy', 429, BusinessCode.RATE_LIMITED),
      ),
    ).toBe(true);
    expect(
      isRetryableFederationNetworkError(
        new S2sResponseError('forbidden', 403, BusinessCode.FORBIDDEN),
      ),
    ).toBe(false);
    expect(isRetryableFederationNetworkError(new SyntaxError('bad json'))).toBe(
      false,
    );
  });
});
