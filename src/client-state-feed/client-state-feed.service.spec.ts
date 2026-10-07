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

  it('normalizes Date values before persisting a client feed body', async () => {
    const values = vi.fn().mockReturnValue({
      onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
    });
    const tx = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      }),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ feedId: 7 }]),
          }),
        }),
      }),
      insert: vi.fn().mockReturnValue({ values }),
    };
    const service = new ClientStateFeedService(
      undefined as never,
      undefined as never,
    );
    const requestedAt = new Date('2026-08-25T07:22:30.552Z');

    await service.writeInTx(tx as never, {
      userId: 1,
      account: 'admin',
      domain: 'chat.example',
      eventType: 'RELATIONSHIP_INTENT',
      namespaceId: 0,
      subjectAccount: '!group',
      subjectNamespaceId: 1,
      body: { status: 'REQUESTED', requestedAt },
    });

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        feedId: 7,
        body: {
          status: 'REQUESTED',
          requestedAt: requestedAt.getTime(),
          established: false,
        },
      }),
    );
  });
});
