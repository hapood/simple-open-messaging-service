import { describe, expect, it, vi } from 'vitest';
import type { FederationReverseThreadSource } from './federation-reverse-thread-source.js';
import { FederationThreadReverseRoundExecutorService } from './federation-thread-reverse-round-executor.service.js';
import { FederationThreadReverseRoundService } from './federation-thread-reverse-round.service.js';
import { FederationThreadSyncStateService } from './federation-thread-sync-state.service.js';

function harness(kind: 'GROUP' | 'P2P' = 'GROUP') {
  const states = {
    prepareMessageRound: vi.fn().mockResolvedValue(undefined),
    reserveReverseTail: vi.fn().mockResolvedValue(undefined),
    resolveReverseWindow: vi.fn().mockResolvedValue({
      authorizationEpoch: 7,
      gapId: 12n,
      beforeSeq: 100,
      throughSeq: 40,
      messageSeqOffset: 8,
    }),
    require: vi.fn(),
  };
  const source: FederationReverseThreadSource =
    kind === 'GROUP'
      ? {
          kind: 'GROUP',
          localGroupAuthority: false,
          namespaceId: 12,
          threadId: 31,
          demand: { account: '!group' },
        }
      : {
          kind: 'P2P',
          namespaceId: 12,
          threadId: 31,
          demand: { account: 'bob', peerAccount: 'alice' },
        };
  const rounds = new FederationThreadReverseRoundService(states as never);
  const executor = new FederationThreadReverseRoundExecutorService(
    {} as never,
    rounds,
    {} as never,
    { commitMessagePageInTx: vi.fn() } as never,
    { publish: vi.fn() } as never,
    { resolve: vi.fn().mockResolvedValue(source) } as never,
    { publishCommitted: vi.fn() } as never,
    { prepare: vi.fn().mockResolvedValue([]) } as never,
  );
  const batch = {
    response: { data: { messages: [], scannedThrough: 40, hasMore: false } },
    before: 100,
    through: 40,
    prefetchedForwardClosures: new Map(),
  };
  const fetchMessages = vi.fn().mockResolvedValue({
    result: { kind: 'page', scannedThrough: 40, hasMore: false },
    batch,
  });
  const commit = vi.fn().mockResolvedValue(undefined);
  Object.assign(executor, {
    fetchMessages,
    commit,
    markUnavailable: vi.fn().mockResolvedValue(undefined),
  });
  return { executor, fetchMessages, commit, source, batch };
}

describe('FederationThreadReverseRoundExecutorService', () => {
  it.each([false, true])(
    'commits reverse facts and progress without a preview dependency (rollback=%s)',
    async (rollback) => {
      const { source, batch } = harness();
      const events: string[] = [];
      const tx = {};
      const threadLock = { tx, threadId: source.threadId };
      const publish = vi.fn(async () => {
        events.push('publish');
      });
      const effects: unknown[] = [];
      const apply = vi.fn(async (actualTx) => {
        expect(actualTx).toBe(tx);
        events.push('facts');
        return effects;
      });
      const finalize = vi.fn(async (actualTx) => {
        expect(actualTx).toBe(tx);
        events.push('finalize');
      });
      const progress = vi
        .spyOn(FederationThreadSyncStateService, 'commitReverseBatchInTx')
        .mockImplementation(async (actualTx, params) => {
          expect(actualTx).toBe(tx);
          await params.writeMessages(threadLock as never);
          events.push('progress');
          return 40;
        });
      const failure = new Error('rollback reverse batch');
      const executor = Object.create(
        FederationThreadReverseRoundExecutorService.prototype,
      );
      Object.assign(executor, {
        database: {
          db: {
            transaction: async (run: (tx: unknown) => Promise<void>) => {
              const result = await run(tx);
              if (rollback) throw failure;
              events.push('commit');
              return result;
            },
          },
        },
        preparation: { prepare: vi.fn().mockResolvedValue([]) },
        inboundMessageCommits: {
          commitMessagePageInTx: apply,
        },
        messageEffects: { publish },
        historyIntervals: { publishCommitted: vi.fn() },
      });
      try {
        const result = executor.commit(
          source,
          {
            authorizationEpoch: 7,
            gapId: 12n,
            gapBeforeSeq: 100,
            nextBeforeSeq: 40,
            throughSeq: 40,
            messageSeqOffset: 8,
          },
          true,
          batch,
          new AbortController().signal,
        );
        if (rollback) {
          await expect(result).rejects.toBe(failure);
          expect(publish).not.toHaveBeenCalled();
          expect(
            executor.historyIntervals.publishCommitted,
          ).not.toHaveBeenCalled();
          expect(events).toEqual(['progress']);
          expect(apply).not.toHaveBeenCalled();
          expect(finalize).not.toHaveBeenCalled();
        } else {
          await result;
          expect(
            executor.historyIntervals.publishCommitted,
          ).not.toHaveBeenCalled();
          expect(events).toEqual(['progress', 'commit']);
          expect(publish).not.toHaveBeenCalled();
        }
      } finally {
        progress.mockRestore();
      }
    },
  );

  it.each([
    [true, 'GROUP', 'account=%21group', 'false'],
    [false, 'GROUP', 'account=%21group', 'true'],
    [false, 'P2P', 'account=bob&peerAccount=alice', 'true'],
  ] as const)(
    'sets the reverse message filter (authority=%s, kind=%s)',
    async (authority, kind, demand, includeSelf) => {
      const { source } = harness(kind);
      if (source.kind === 'GROUP') source.localGroupAuthority = authority;
      const fetch = vi.fn().mockResolvedValue({
        data: { messages: [], scannedThrough: 40, hasMore: false },
      });
      const executor = Object.create(
        FederationThreadReverseRoundExecutorService.prototype,
      );
      Object.assign(executor, { threadResources: { fetch } });
      const signal = new AbortController().signal;
      await executor.fetchMessages(
        source,
        {
          before: 100,
          through: 40,
          take: 20,
        },
        signal,
      );
      expect(fetch).toHaveBeenCalledWith(
        31,
        `/somfp/v1/messages?${demand}&before=100&through=40&take=20&includeSelf=${includeSelf}`,
        source.namespaceId,
        signal,
        16 * 1024 * 1024,
      );
    },
  );
  it('executes one group gap without changing wire boundaries', async () => {
    const { executor, fetchMessages, commit, source, batch } = harness();

    await expect(
      executor.run(31, 12, new AbortController().signal, 20),
    ).resolves.toMatchObject({
      beforeSeq: 100,
      throughSeq: 40,
      batchOldestSeq: 40,
      closesGap: true,
    });
    expect(fetchMessages).toHaveBeenCalledWith(
      source,
      {
        threadId: 31,
        before: 100,
        through: 40,
        take: 20,
      },
      expect.any(AbortSignal),
    );
    expect(commit).toHaveBeenCalledWith(
      source,
      {
        authorizationEpoch: 7,
        gapId: 12n,
        gapBeforeSeq: 100,
        nextBeforeSeq: 40,
        throughSeq: 40,
        messageSeqOffset: 8,
      },
      true,
      batch,
      expect.any(AbortSignal),
    );
  });

  it('executes P2P history without profile reverse queries', async () => {
    const { executor, commit } = harness('P2P');
    await expect(
      executor.run(31, 12, new AbortController().signal),
    ).resolves.toBeDefined();
    expect(commit).toHaveBeenCalledOnce();
  });

  it('does not commit a fetched reverse page after the caller cancels', async () => {
    const controller = new AbortController();
    const { source, batch } = harness();
    const transaction = vi.fn();
    const prepare = vi.fn().mockImplementation(async () => {
      controller.abort();
      return [];
    });
    const executor = Object.create(
      FederationThreadReverseRoundExecutorService.prototype,
    );
    Object.assign(executor, {
      database: { db: { transaction } },
      preparation: { prepare },
      inboundMessageCommits: { commitMessagePageInTx: vi.fn() },
      messageEffects: { publish: vi.fn() },
      historyIntervals: { publishCommitted: vi.fn() },
    });

    await expect(
      executor.commit(
        source,
        {
          authorizationEpoch: 7,
          gapId: 12n,
          gapBeforeSeq: 100,
          nextBeforeSeq: 40,
          throughSeq: 40,
          messageSeqOffset: 8,
        },
        true,
        batch,
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(transaction).not.toHaveBeenCalled();
  });
});
