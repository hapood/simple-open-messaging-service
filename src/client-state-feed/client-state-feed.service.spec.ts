import { describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { ClientStateFeedService } from './client-state-feed.service.js';

const dialect = new PgDialect();

vi.mock('../state-feed/state-feed-fanout-task.js', () => ({
  enqueueStateFeedFanoutInTx: vi.fn().mockResolvedValue(undefined),
}));

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
      domain: 'local',
      eventType: 'RELATIONSHIP_INTENT',
      subjectAccount: '!group',
      subjectDomain: 'alpha.test',
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

  it('checks canonical Group Meta before removing an unreferenced profile', async () => {
    const execute = vi.fn().mockResolvedValue({
      rows: [{ referenced: true }],
    });
    const tx = {
      query: {
        account: {
          findFirst: vi.fn().mockResolvedValue({
            account: 'member',
            domain: 'peer.test',
          }),
        },
      },
      execute,
    };
    const service = new ClientStateFeedService(
      undefined as never,
      undefined as never,
    );

    await service.cleanupProfileStateIfUnreferencedInTx(tx as never, 1, 2);

    const query = dialect.sqlToQuery(execute.mock.calls[0]![0] as SQL).sql;
    expect(query).toContain('FROM "GroupMetaMemberFeed" member_fact');
    expect(query).toContain('JOIN "RelationshipPair" owner_pair');
    expect(query).not.toContain('ClientGroupMetaMemberFeed');
  });

  it('publishes the shared Group Meta head to each active local account state', async () => {
    const service = new ClientStateFeedService(
      undefined as never,
      undefined as never,
    );
    vi.spyOn(service, 'writeInTx').mockResolvedValue(9);
    const tx = {
      select: () => ({
        from: () => ({
          where: async () => [{ userId: 7, feedId: 10, threadFeedEndId: 3 }],
        }),
      }),
      execute: vi
        .fn()
        .mockResolvedValueOnce({
          rows: [
            {
              groupId: 3,
              account: '!team',
              domain: 'local',
              displayName: 'Team',
              bio: 'Group bio',
              avatar: '',
              profileRev: 1,
              namespaceId: 0,
              groupMetaFeedEndId: '4',
            },
          ],
        })
        .mockResolvedValueOnce({
          rows: [{ userId: 7 }],
        }),
    };

    await expect(
      service.publishGroupStateToLocalAccountsInTx(tx as never, 11),
    ).resolves.toEqual([
      { userId: 7, feedId: 9 },
      { userId: 7, feedId: 9 },
      { userId: 7, feedId: 10, threadFeedEndId: 3 },
    ]);

    expect(service.writeInTx).toHaveBeenNthCalledWith(
      2,
      tx,
      expect.objectContaining({
        userId: 7,
        eventType: 'GROUP_META_FEED_HEAD',
        body: { groupMetaFeedEndId: '4' },
      }),
    );
  });
});
