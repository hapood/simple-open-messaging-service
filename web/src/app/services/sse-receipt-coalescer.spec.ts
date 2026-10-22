import { afterEach, describe, expect, it, vi } from 'vitest';
import { SseReceiptCoalescer } from './sse-receipt-coalescer';

const receipt = (threadFeedEndId: number, sseUuid = 'connection') => ({
  sseUuid,
  threadFeedEndId,
});

describe('SseReceiptCoalescer', () => {
  afterEach(() => vi.useRealTimers());

  it('sends the latest receipt three seconds after the first event, without trailing debounce', async () => {
    vi.useFakeTimers();
    const send = vi.fn().mockResolvedValue(undefined);
    const receipts = new SseReceiptCoalescer(send);
    receipts.queue(receipt(1));
    await vi.advanceTimersByTimeAsync(1_000);
    receipts.queue(receipt(2));
    await vi.advanceTimersByTimeAsync(1_000);
    receipts.queue(receipt(3));
    await vi.advanceTimersByTimeAsync(999);
    expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledExactlyOnceWith(
      receipt(3),
      expect.any(AbortSignal),
    );
    receipts.stop();
  });

  it('never sends two requests concurrently and retains only the latest pending ID', async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const send = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue(undefined);
    const receipts = new SseReceiptCoalescer(send);
    receipts.queue(receipt(1));
    await vi.advanceTimersByTimeAsync(3_000);
    receipts.queue(receipt(2));
    await vi.advanceTimersByTimeAsync(1_000);
    receipts.queue(receipt(3));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(send).toHaveBeenCalledTimes(1);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0]).toEqual(receipt(3));
    receipts.stop();
  });

  it('retries a failed receipt only once and cancels an in-flight send on stop', async () => {
    vi.useFakeTimers();
    const send = vi.fn().mockRejectedValue(new Error('network'));
    const receipts = new SseReceiptCoalescer(send);
    receipts.queue(receipt(1));
    await vi.advanceTimersByTimeAsync(4_000);
    expect(send).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(send).toHaveBeenCalledTimes(2);
    receipts.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});
