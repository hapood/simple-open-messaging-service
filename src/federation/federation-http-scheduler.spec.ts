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

  it('retries typed transport failures with exponential scheduling', async () => {
    vi.useFakeTimers();
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new FederationTransportError('timeout one'))
      .mockRejectedValueOnce(new FederationTransportError('timeout two'))
      .mockResolvedValueOnce('ok');
    const result = scheduler(1, 1).runWithRetry(
      'peer.test',
      'group-meta page',
      operation,
    );

    await vi.waitFor(() => expect(operation).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(operation).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2_000);

    await expect(result).resolves.toBe('ok');
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it('honors retryAfter and returns permanent failures immediately', async () => {
    vi.useFakeTimers();
    const temporary = new S2sResponseError(
      'busy',
      429,
      BusinessCode.RATE_LIMITED,
      { retryAfter: 5 },
    );
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(temporary)
      .mockResolvedValueOnce('ok');
    const result = scheduler(1, 1).runWithRetry(
      'peer.test',
      'group-meta page',
      operation,
    );

    await vi.waitFor(() => expect(operation).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(4_999);
    expect(operation).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe('ok');

    const permanent = new S2sResponseError(
      'forbidden',
      403,
      BusinessCode.FORBIDDEN,
    );
    await expect(
      scheduler(1, 1).runWithRetry('peer.test', 'group-meta page', () =>
        Promise.reject(permanent),
      ),
    ).rejects.toBe(permanent);
    expect(isRetryableFederationNetworkError(new SyntaxError('bad json'))).toBe(
      false,
    );
  });
});
