import { describe, expect, it, vi } from 'vitest';
import { ClientStateFeedService } from './client-state-feed.service.js';

describe('ClientStateFeedService', () => {
  it('publishes one wake per request event and none for thread-feed events', () => {
    const enqueueForRequestAttention = vi.fn().mockResolvedValue(undefined);
    const onThreadFeedUpdated = vi.fn();
    const service = new ClientStateFeedService(
      undefined as never,
      { onStateFeedUpdated: vi.fn(), onThreadFeedUpdated } as never,
      { enqueueForRequestAttention } as never,
    );
    service.notifyFeedUpdates([
      { kind: 'personal-request-arrival', userId: 1, feedId: 9 },
      {
        kind: 'group-request-read',
        userId: 1,
        feedId: 8,
        threadFeedEndId: 4,
      },
      { kind: 'thread-feed', userId: 2, feedId: 4, threadFeedEndId: 50 },
      { kind: 'personal-request-read', userId: 1, feedId: 7 },
      {
        kind: 'group-request-arrival',
        userId: 3,
        feedId: 6,
        threadFeedEndId: 11,
      },
    ]);
    // Independent events never merge into one wake; PushService coalesces
    // per session by coordinate.
    expect(enqueueForRequestAttention).toHaveBeenCalledTimes(4);
    expect(enqueueForRequestAttention).toHaveBeenNthCalledWith(1, [
      { userId: 1, stateFeedEndId: 9, convergence: false },
    ]);
    expect(enqueueForRequestAttention).toHaveBeenNthCalledWith(2, [
      { userId: 1, threadFeedEndId: 4, convergence: true },
    ]);
    expect(enqueueForRequestAttention).toHaveBeenNthCalledWith(3, [
      { userId: 1, stateFeedEndId: 7, convergence: true },
    ]);
    expect(enqueueForRequestAttention).toHaveBeenNthCalledWith(4, [
      { userId: 3, threadFeedEndId: 11, convergence: false },
    ]);
    expect(onThreadFeedUpdated).toHaveBeenCalledWith(1, {
      threadFeedEndId: 4,
    });
    expect(onThreadFeedUpdated).toHaveBeenCalledWith(2, {
      threadFeedEndId: 50,
    });
    expect(onThreadFeedUpdated).toHaveBeenCalledWith(3, {
      threadFeedEndId: 11,
    });
  });
  it('forwards state and thread feed hints immediately to SseService for leading-edge throttling', () => {
    const onStateFeedUpdated = vi.fn();
    const onThreadFeedUpdated = vi.fn();
    const service = new ClientStateFeedService(
      undefined as never,
      { onStateFeedUpdated, onThreadFeedUpdated } as never,
      {
        enqueueForRequestAttention: vi.fn().mockResolvedValue(undefined),
      } as never,
    );
    service.notifyFeedUpdates([
      { kind: 'thread-feed', userId: 1, feedId: 9, threadFeedEndId: 4 },
      { kind: 'thread-feed', userId: 1, feedId: 7, threadFeedEndId: 8 },
      { kind: 'thread-feed', userId: 2, feedId: 2, threadFeedEndId: 3 },
      { kind: 'personal-request-arrival', userId: 3, feedId: 5 },
    ]);
    expect(onThreadFeedUpdated).toHaveBeenCalledTimes(3);
    expect(onThreadFeedUpdated).toHaveBeenCalledWith(1, {
      threadFeedEndId: 4,
    });
    expect(onThreadFeedUpdated).toHaveBeenCalledWith(1, {
      threadFeedEndId: 8,
    });
    expect(onThreadFeedUpdated).toHaveBeenCalledWith(2, {
      threadFeedEndId: 3,
    });
    expect(onStateFeedUpdated).toHaveBeenCalledTimes(4);
    expect(onStateFeedUpdated).toHaveBeenNthCalledWith(1, 1, { feedId: 9 });
    expect(onStateFeedUpdated).toHaveBeenNthCalledWith(2, 1, { feedId: 7 });
    expect(onStateFeedUpdated).toHaveBeenNthCalledWith(3, 2, { feedId: 2 });
    expect(onStateFeedUpdated).toHaveBeenNthCalledWith(4, 3, { feedId: 5 });
  });

  it.each([false, true])(
    'publishes only a complete changed request head (unchanged=%s)',
    async (unchanged) => {
      const head = { requestEndId: '9007199254740993', requestReadId: '42' };
      const lock = vi.fn().mockResolvedValue([
        {
          requestEndId: 9007199254740993n,
          requestReadId: 42n,
        },
      ]);
      const values = vi.fn().mockReturnValue({
        onConflictDoUpdate: () => ({
          returning: () => Promise.resolve([{ feedId: 7 }]),
        }),
      });
      const tx = {
        select: vi
          .fn()
          .mockReturnValueOnce({
            from: () => ({ where: () => ({ for: lock }) }),
          })
          .mockReturnValueOnce({
            from: () => ({
              where: () => ({
                limit: () => Promise.resolve(unchanged ? [{ body: head }] : []),
              }),
            }),
          }),
        update: vi.fn().mockReturnValue({
          set: () => ({
            where: () => ({
              returning: () => Promise.resolve([{ feedId: 7 }]),
            }),
          }),
        }),
        insert: vi.fn().mockReturnValue({ values }),
      };
      const service = new ClientStateFeedService(
        undefined as never,
        undefined as never,
        undefined as never,
      );
      await expect(
        service.publishRequestHeadInTx(tx as never, 1),
      ).resolves.toBe(unchanged ? null : 7);
      expect(lock).toHaveBeenCalledExactlyOnceWith('no key update');
      if (unchanged) {
        expect(tx.update).not.toHaveBeenCalled();
        expect(tx.insert).not.toHaveBeenCalled();
      } else {
        expect(values).toHaveBeenCalledExactlyOnceWith({
          userId: 1,
          feedId: 7,
          threadId: 0,
          type: 'REQUEST_HEAD',
          body: head,
        });
      }
    },
  );
});
