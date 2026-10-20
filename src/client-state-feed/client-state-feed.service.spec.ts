import { describe, expect, it, vi } from 'vitest';
import { ClientStateFeedService } from './client-state-feed.service.js';

describe('ClientStateFeedService', () => {
  it('merges independent thread heads and does not suppress them with an unchanged state head', async () => {
    vi.useFakeTimers();
    const onStateFeedUpdated = vi.fn();
    const onThreadFeedUpdated = vi.fn();
    const service = new ClientStateFeedService(
      undefined as never,
      { onStateFeedUpdated, onThreadFeedUpdated } as never,
    );
    try {
      service.notifyFeedUpdates([
        { userId: 1, feedId: 9, threadFeedEndId: 4 },
        { userId: 1, feedId: 7, threadFeedEndId: 8 },
        { userId: 2, feedId: 2, threadFeedEndId: 3 },
      ]);
      expect(onThreadFeedUpdated).toHaveBeenCalledWith(1, {
        threadFeedEndId: 8,
      });
      expect(onThreadFeedUpdated).toHaveBeenCalledWith(2, {
        threadFeedEndId: 3,
      });
      await vi.advanceTimersByTimeAsync(1000);
      expect(onStateFeedUpdated).toHaveBeenCalledWith(1, { feedId: 9 });
      service.notifyFeedUpdated({ userId: 1, feedId: 9, threadFeedEndId: 10 });
      expect(onThreadFeedUpdated).toHaveBeenLastCalledWith(1, {
        threadFeedEndId: 10,
      });
      await vi.advanceTimersByTimeAsync(1000);
      expect(onStateFeedUpdated).toHaveBeenCalledTimes(2);
    } finally {
      service.onModuleDestroy();
      vi.useRealTimers();
    }
  });
  it('coalesces committed SSE high watermarks in an independent window per feed', async () => {
    vi.useFakeTimers();
    const onStateFeedUpdated = vi.fn();
    const service = new ClientStateFeedService(
      undefined as never,
      { onStateFeedUpdated } as never,
    );

    service.notifyFeedUpdates([
      { userId: 1, feedId: 4 },
      { userId: 2, feedId: 3 },
      { userId: 1, feedId: 9 },
      { userId: 2, feedId: 2 },
    ]);

    expect(onStateFeedUpdated).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onStateFeedUpdated).toHaveBeenCalledTimes(2);
    expect(onStateFeedUpdated).toHaveBeenCalledWith(1, { feedId: 9 });
    expect(onStateFeedUpdated).toHaveBeenCalledWith(2, { feedId: 3 });
    service.onModuleDestroy();
    vi.useRealTimers();
  });

  it('does not share one feed coalescing window with a later feed', async () => {
    vi.useFakeTimers();
    const onStateFeedUpdated = vi.fn();
    const service = new ClientStateFeedService(
      undefined as never,
      { onStateFeedUpdated } as never,
    );

    service.notifyFeedUpdated({ userId: 1, feedId: 4 });
    await vi.advanceTimersByTimeAsync(500);
    service.notifyFeedUpdated({ userId: 2, feedId: 8 });
    await vi.advanceTimersByTimeAsync(500);

    expect(onStateFeedUpdated).toHaveBeenCalledTimes(1);
    expect(onStateFeedUpdated).toHaveBeenLastCalledWith(1, { feedId: 4 });

    await vi.advanceTimersByTimeAsync(500);
    expect(onStateFeedUpdated).toHaveBeenCalledTimes(2);
    expect(onStateFeedUpdated).toHaveBeenLastCalledWith(2, { feedId: 8 });
    service.onModuleDestroy();
    vi.useRealTimers();
  });

  it('retains each feed high watermark beyond its one-second window', async () => {
    vi.useFakeTimers();
    const onStateFeedUpdated = vi.fn();
    const service = new ClientStateFeedService(
      undefined as never,
      { onStateFeedUpdated } as never,
    );

    service.notifyFeedUpdated({ userId: 1, feedId: 9 });
    await vi.advanceTimersByTimeAsync(1_000);
    service.notifyFeedUpdated({ userId: 1, feedId: 7 });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(onStateFeedUpdated).toHaveBeenCalledTimes(1);
    expect(onStateFeedUpdated).toHaveBeenLastCalledWith(1, { feedId: 9 });

    service.notifyFeedUpdated({ userId: 1, feedId: 10 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onStateFeedUpdated).toHaveBeenCalledTimes(2);
    expect(onStateFeedUpdated).toHaveBeenLastCalledWith(1, { feedId: 10 });
    service.onModuleDestroy();
    vi.useRealTimers();
  });

  it.each([false, true])('publishes only a complete changed request head (unchanged=%s)', async (unchanged) => {
    const head = { requestEndId: '9007199254740993', requestReadId: '42' };
    const lock = vi.fn().mockResolvedValue([{
      requestEndId: 9007199254740993n, requestReadId: 42n,
    }]);
    const values = vi.fn().mockResolvedValue(undefined);
    const tx = {
      select: vi.fn()
        .mockReturnValueOnce({ from: () => ({ where: () => ({ for: lock }) }) })
        .mockReturnValueOnce({ from: () => ({ where: () => ({ orderBy: () => ({ limit: () => Promise.resolve(unchanged ? [{ body: head }] : []) }) }) }) }),
      update: vi.fn().mockReturnValue({ set: () => ({ where: () => ({
        returning: () => Promise.resolve([{ feedId: 7 }]),
      }) }) }),
      insert: vi.fn().mockReturnValue({ values }),
    };
    const service = new ClientStateFeedService(undefined as never, undefined as never);
    await expect(service.publishRequestHeadInTx(tx as never, 1)).resolves.toBe(unchanged ? null : 7);
    expect(lock).toHaveBeenCalledExactlyOnceWith('no key update');
    if (unchanged) {
      expect(tx.update).not.toHaveBeenCalled();
      expect(tx.insert).not.toHaveBeenCalled();
    } else {
      expect(values).toHaveBeenCalledExactlyOnceWith({ userId: 1, feedId: 7, body: head });
    }
  });
});
