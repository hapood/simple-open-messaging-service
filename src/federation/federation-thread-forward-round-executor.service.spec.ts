import { afterEach, describe, expect, it, vi } from 'vitest';
import { BusinessCode } from '../common/business-code.js';
import { S2sResponseError } from './federation-errors.js';
import { FederationThreadForwardRoundExecutorService } from './federation-thread-forward-round-executor.service.js';
import type {
  FederationThreadForwardMessageRoundDriver,
  FederationThreadForwardTombstoneRoundDriver,
} from './federation-thread-forward-round.service.js';
import { FederationThreadSyncStateService } from './federation-thread-sync-state.service.js';

afterEach(() => vi.restoreAllMocks());

function response(data: object) {
  return {
    data,
    threadId: 31,
    peerDomain: 'origin.test',
    peerToken: {
      domain: 'origin.test',
      namespaceId: 1,
      rootKeyFingerprint: 'fingerprint',
    },
  };
}

function harness(localGroupAuthority = false, kind: 'GROUP' | 'P2P' = 'GROUP') {
  const publishMessage = vi.fn().mockResolvedValue(undefined);
  const inboundMessageCommits = {
    applyForwardInTransaction: vi.fn().mockResolvedValue([]),
    applyTombstonesInTransaction: vi.fn().mockResolvedValue({ deletions: [] }),
  };
  const messageEffects = { publish: publishMessage };
  const threadResources = { fetch: vi.fn() };
  const rounds = {
    runMessages: vi.fn(
      async (
        threadId: number,
        _namespaceId: number,
        driver: FederationThreadForwardMessageRoundDriver,
        signal: AbortSignal,
        take: number,
      ) => {
        signal.throwIfAborted();
        await driver.process({
          threadId,
          after: 10,
          through: 100,
          take,
        });
        signal.throwIfAborted();
        await driver.complete({
          threadId,
          authorizationEpoch: 4,
          targetSeq: 100,
        });
        return { targetSeq: 100, processed: true };
      },
    ),
    runTombstones: vi.fn(
      async (
        threadId: number,
        _namespaceId: number,
        driver: FederationThreadForwardTombstoneRoundDriver,
        signal: AbortSignal,
        take: number,
      ) => {
        signal.throwIfAborted();
        const targetSeq = 9;
        const maxMessageSeq = 42;
        await driver.process({
          threadId,
          after: 4,
          through: targetSeq,
          maxMessageSeq,
          take,
        });
        signal.throwIfAborted();
        await driver.complete({
          threadId,
          authorizationEpoch: 4,
          targetSeq,
        });
        return { targetSeq, maxMessageSeq, processed: true } as {
          targetSeq: number;
          maxMessageSeq?: number;
          processed: boolean;
        };
      },
    ),
  };
  const tx = { execute: vi.fn().mockResolvedValue({ rows: [{ id: 1 }] }) };
  const database = {
    db: {
      transaction: vi.fn((callback: (tx: object) => Promise<void>) =>
        callback(tx),
      ),
    },
  };
  const messageAdvance = vi
    .spyOn(
      FederationThreadSyncStateService,
      'advanceMessageProcessedThroughInTx',
    )
    .mockResolvedValue(undefined);
  const deletionAdvance = vi
    .spyOn(
      FederationThreadSyncStateService,
      'advanceDeletionProcessedThroughInTx',
    )
    .mockResolvedValue(undefined);
  const epochLock = vi
    .spyOn(FederationThreadSyncStateService, 'lockAuthorizationEpochInTx')
    .mockResolvedValue({ threadId: 31, tx } as never);
  const executor = new FederationThreadForwardRoundExecutorService(
    rounds as never,
    threadResources as never,
    inboundMessageCommits as never,
    messageEffects as never,
    {
      resolve: vi.fn().mockResolvedValue({
        kind,
        localGroupAuthority,
        threadId: 31,
        namespaceId: 7,
        peerDomain: 'origin.test',
        demand:
          kind === 'GROUP'
            ? { account: '!group' }
            : { account: 'bob', peerAccount: 'alice' },
      }),
    } as never,
    database as never,
    { prepare: vi.fn().mockResolvedValue([]) } as never,
  );
  return {
    executor,
    rounds,
    inboundMessageCommits,
    threadResources,
    database,
    publishMessage,
    messageAdvance,
    deletionAdvance,
    epochLock,
    tx,
  };
}

describe('FederationThreadForwardRoundExecutorService', () => {
  it.each(['message', 'tombstone'] as const)(
    'rejects a buffered %s page without writing facts or progress after audience removal',
    async (kind) => {
      const h = harness(true);
      h.tx.execute.mockResolvedValue({ rows: [] });
      h.threadResources.fetch.mockResolvedValueOnce(
        response(
          kind === 'message'
            ? { messages: [], scannedThrough: 100, hasMore: false }
            : { tombstones: [], scannedThrough: 9, hasMore: false },
        ),
      );
      const run =
        kind === 'message'
          ? h.executor.runMessages(31, 7, new AbortController().signal, 50)
          : h.executor.runTombstones(31, 7, new AbortController().signal, 50);
      await expect(run).rejects.toThrow('no longer has an audience');
      expect(h.epochLock.mock.invocationCallOrder[0]).toBeLessThan(
        h.tx.execute.mock.invocationCallOrder[0],
      );
      expect(
        h.inboundMessageCommits.applyForwardInTransaction,
      ).not.toHaveBeenCalled();
      expect(
        h.inboundMessageCommits.applyTombstonesInTransaction,
      ).not.toHaveBeenCalled();
      expect(h.messageAdvance).not.toHaveBeenCalled();
      expect(h.deletionAdvance).not.toHaveBeenCalled();
      expect(h.publishMessage).not.toHaveBeenCalled();
      expect(
        h.inboundMessageCommits.applyTombstonesInTransaction,
      ).not.toHaveBeenCalled();
    },
  );
  it.each([
    [true, 'GROUP', 'account=%21group', 'false'],
    [false, 'GROUP', 'account=%21group', 'true'],
    [false, 'P2P', 'account=bob&peerAccount=alice', 'true'],
  ] as const)(
    'sets the message filter without blocking empty-page progress (authority=%s, kind=%s)',
    async (authority, kind, demand, includeSelf) => {
      const h = harness(authority, kind);
      h.threadResources.fetch.mockResolvedValueOnce(
        response({ messages: [], scannedThrough: 100, hasMore: false }),
      );
      await h.executor.runMessages(31, 7, new AbortController().signal, 50);
      expect(h.threadResources.fetch).toHaveBeenCalledWith(
        31,
        `/somfp/v1/messages?${demand}&after=10&through=100&take=50&includeSelf=${includeSelf}`,
        7,
        expect.any(AbortSignal),
        16 * 1024 * 1024,
      );
      expect(h.messageAdvance).toHaveBeenCalledWith(h.tx, 31, 100, 100, 7);
    },
  );
  it('commits a message page and its cursor independently', async () => {
    const h = harness();
    h.threadResources.fetch.mockResolvedValueOnce(
      response({ messages: [], scannedThrough: 60, hasMore: true }),
    );

    await h.executor.runMessages(31, 7, new AbortController().signal, 50);

    expect(h.threadResources.fetch).toHaveBeenCalledWith(
      31,
      '/somfp/v1/messages?account=%21group&after=10&through=100&take=50&includeSelf=true',
      7,
      expect.any(AbortSignal),
      16 * 1024 * 1024,
    );
    expect(h.messageAdvance).toHaveBeenCalledWith(h.tx, 31, 60, 100, 7);
    expect(h.deletionAdvance).not.toHaveBeenCalled();
    expect(h.epochLock).toHaveBeenCalledWith(h.tx, 31, 4);
    expect(h.publishMessage).not.toHaveBeenCalled();
    expect(
      h.inboundMessageCommits.applyTombstonesInTransaction,
    ).not.toHaveBeenCalled();
  });

  it('commits an independently bounded tombstone page with its frozen cutoff', async () => {
    const h = harness();
    h.threadResources.fetch.mockResolvedValueOnce(
      response({ tombstones: [], scannedThrough: 9, hasMore: false }),
    );

    await h.executor.runTombstones(31, 7, new AbortController().signal, 50);

    expect(h.threadResources.fetch).toHaveBeenCalledWith(
      31,
      '/somfp/v1/message-tombstones?account=%21group&after=4&through=9&take=50&includeSelf=true&maxMessageSeq=42',
      7,
      expect.any(AbortSignal),
      4 * 1024 * 1024,
    );
    expect(h.deletionAdvance).toHaveBeenCalledWith(h.tx, 31, 4, 9, 7);
    expect(h.messageAdvance).not.toHaveBeenCalled();
    expect(h.epochLock).toHaveBeenCalledWith(h.tx, 31, 4);
    expect(
      h.inboundMessageCommits.applyTombstonesInTransaction,
    ).toHaveBeenCalledOnce();
    expect(h.publishMessage).not.toHaveBeenCalled();
  });

  it('continues sending maxMessageSeq after the recovery drain is complete', async () => {
    const h = harness();
    h.rounds.runTombstones.mockImplementationOnce(
      async (
        threadId: number,
        _namespaceId: number,
        driver: FederationThreadForwardTombstoneRoundDriver,
        signal: AbortSignal,
        take?: number,
      ) => {
        signal.throwIfAborted();
        await driver.process({
          threadId,
          after: 9,
          through: 12,
          maxMessageSeq: 60,
          take: take!,
        });
        return { targetSeq: 12, processed: true };
      },
    );
    h.threadResources.fetch.mockResolvedValueOnce(
      response({ tombstones: [], scannedThrough: 12, hasMore: false }),
    );

    await h.executor.runTombstones(31, 7, new AbortController().signal, 50);

    expect(h.threadResources.fetch).toHaveBeenCalledWith(
      31,
      '/somfp/v1/message-tombstones?account=%21group&after=9&through=12&take=50&includeSelf=true&maxMessageSeq=60',
      7,
      expect.any(AbortSignal),
      4 * 1024 * 1024,
    );
  });

  it.each([true, false])(
    'advances only applied facts, not scannedThrough (hasMore=%s)',
    async (hasMore) => {
      const h = harness();
      h.threadResources.fetch.mockResolvedValueOnce(
        response({
          tombstones: [
            {
              deletionSeq: 5,
              thread: { account: '!group' },
              messageSeq: 40,
              type: 'USER_RETRACTION',
              deletedAt: 1,
            },
          ],
          scannedThrough: hasMore ? 8 : 9,
          hasMore,
        }),
      );
      await expect(
        h.executor.runTombstones(31, 7, new AbortController().signal, 50),
      ).resolves.toMatchObject({ hasMore });
      expect(h.deletionAdvance).toHaveBeenCalledWith(h.tx, 31, 5, 9, 7);
    },
  );

  it('waits after an empty cutoff page without adopting source progress', async () => {
    const h = harness();
    h.threadResources.fetch.mockResolvedValueOnce(
      response({
        tombstones: [],
        scannedThrough: 9,
        hasMore: false,
      }),
    );
    await expect(
      h.executor.runTombstones(31, 7, new AbortController().signal, 50),
    ).resolves.toMatchObject({ hasMore: false });
    expect(h.deletionAdvance).toHaveBeenCalledWith(h.tx, 31, 4, 9, 7);
  });

  it('recovers a retained source boundary without treating it as applied deletion progress', async () => {
    const h = harness();
    h.threadResources.fetch
      .mockRejectedValueOnce(
        new S2sResponseError(
          'cursor unavailable',
          409,
          BusinessCode.FEDERATION_FEED_CURSOR_UNAVAILABLE,
          { resumeAfter: 6, resumeBefore: 10 },
        ),
      )
      .mockResolvedValueOnce(
        response({ tombstones: [], scannedThrough: 9, hasMore: false }),
      );
    await expect(
      h.executor.runTombstones(31, 7, new AbortController().signal, 50),
    ).resolves.toMatchObject({ hasMore: false });
    expect(h.threadResources.fetch.mock.calls[1][1]).toContain('after=6');
    expect(h.deletionAdvance).toHaveBeenCalledWith(h.tx, 31, 4, 9, 7);
  });

  it('does not advance applied progress when the tombstone transaction fails', async () => {
    const h = harness();
    h.threadResources.fetch.mockResolvedValueOnce(
      response({
        tombstones: [
          {
            deletionSeq: 5,
            thread: { account: '!group' },
            messageSeq: 40,
            type: 'USER_RETRACTION',
            deletedAt: 1,
          },
        ],
        scannedThrough: 9,
        hasMore: false,
      }),
    );
    h.inboundMessageCommits.applyTombstonesInTransaction.mockRejectedValueOnce(
      new Error('failed to apply fact'),
    );
    await expect(
      h.executor.runTombstones(31, 7, new AbortController().signal, 50),
    ).rejects.toThrow('failed to apply fact');
    expect(h.deletionAdvance).not.toHaveBeenCalled();
  });

  it('rejects a tombstone above the current message cutoff', async () => {
    const h = harness();
    h.threadResources.fetch.mockResolvedValueOnce(
      response({
        tombstones: [
          {
            deletionSeq: 5,
            thread: { account: '!group' },
            messageSeq: 43,
            type: 'USER_RETRACTION',
            deletedAt: 1,
          },
        ],
        scannedThrough: 9,
        hasMore: false,
      }),
    );

    await expect(
      h.executor.runTombstones(31, 7, new AbortController().signal, 50),
    ).rejects.toMatchObject({
      bizCode: BusinessCode.FEDERATION_MALFORMED,
    });
    expect(h.deletionAdvance).not.toHaveBeenCalled();
  });

  it('does not commit a fetched forward message page after the caller cancels', async () => {
    const h = harness();
    const controller = new AbortController();
    h.threadResources.fetch.mockImplementationOnce(async () => {
      controller.abort();
      return response({ messages: [], scannedThrough: 60, hasMore: true });
    });

    await expect(
      h.executor.runMessages(31, 7, controller.signal, 50),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(h.database.db.transaction).not.toHaveBeenCalled();
    expect(h.messageAdvance).not.toHaveBeenCalled();
  });
});
