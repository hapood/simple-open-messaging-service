import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountFeedThrottle } from './account-feed-throttle.js';

describe('account feed throttle', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('sends immediately, merges maximum heads without extending the window, and expires idle accounts', async () => {
    const send = vi.fn();
    const throttle = new AccountFeedThrottle(15_000, send, vi.fn());
    throttle.enqueue(1, 4);
    expect(send).toHaveBeenCalledExactlyOnceWith(1, 4);
    await vi.advanceTimersByTimeAsync(3000);
    throttle.enqueue(1, 9);
    throttle.enqueue(1, 7);
    throttle.enqueue(2, 2);
    await vi.advanceTimersByTimeAsync(11_999);
    expect(send).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenLastCalledWith(1, 9);
    throttle.enqueue(1, 9);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(send).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
    throttle.enqueue(1, 10);
    expect(send).toHaveBeenLastCalledWith(1, 10);
    throttle.stop();
  });

  it('serializes slow sends and preserves arrivals while a provider is pending', async () => {
    let finish!: () => void;
    const send = vi.fn().mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const throttle = new AccountFeedThrottle(15_000, send, vi.fn());
    throttle.enqueue(1, 1);
    throttle.enqueue(1, 2);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(send).toHaveBeenCalledTimes(1);
    finish();
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenLastCalledWith(1, 2);
    throttle.stop();
  });

  it('isolates failures and cancels pending work on shutdown', async () => {
    const error = new Error('provider unavailable');
    const send = vi.fn().mockRejectedValueOnce(error);
    const failed = vi.fn();
    const throttle = new AccountFeedThrottle(15_000, send, failed);
    throttle.enqueue(1, 1);
    throttle.enqueue(1, 2);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(failed).toHaveBeenCalledWith(error);
    expect(send).toHaveBeenLastCalledWith(1, 2);
    throttle.enqueue(1, 3);
    throttle.stop();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(send).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});
