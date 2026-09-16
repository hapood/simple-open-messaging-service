import { describe, expect, it, vi } from 'vitest';
import type { FederationReverseThreadSource } from './federation-reverse-thread-source.js';
import { FederationThreadReverseRoundExecutorService } from './federation-thread-reverse-round-executor.service.js';
import { FederationThreadReverseRoundService } from './federation-thread-reverse-round.service.js';
import { FederationThreadSyncStateService } from './federation-thread-sync-state.service.js';

function harness(kind: 'GROUP' | 'P2P' = 'GROUP') {
  const states = {
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
          peerDomain: 'origin.test',
          selector: { account: '!group' },
        }
      : {
          kind: 'P2P',
          namespaceId: 12,
          threadId: 31,
          peerDomain: 'peer.test',
          selector: { account: 'bob', peerAccount: 'alice' },
        };
  const rounds = new FederationThreadReverseRoundService(states as never);
  const executor = new FederationThreadReverseRoundExecutorService(
    {} as never,
    rounds,
    {} as never,
    {} as never,
    { resolve: vi.fn().mockResolvedValue(source) } as never,
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
      const apply = vi.fn(async (actualTx) => {
        expect(actualTx).toBe(tx);
        events.push('facts');
        return { publish };
      });
      const finalize = vi.fn(async (actualTx) => {
        expect(actualTx).toBe(tx);
        events.push('finalize');
      });
      const progress = vi
        .spyOn(FederationThreadSyncStateService, 'commitReverseBatchInTx')
        .mockImplementation(async (actualTx, params) => {
          expect(actualTx).toBe(tx);
          // The executor always supplies applyDependencies for batch commits.
          await params.applyDependencies!(threadLock as never);
          events.push('progress');
        });
      const failure = new Error('rollback reverse batch');
      const executor = Object.create(
        FederationThreadReverseRoundExecutorService.prototype,
      );
      Object.assign(executor, {
        database: {
          db: {
            transaction: async (run: (tx: unknown) => Promise<void>) => {
              await run(tx);
              if (rollback) throw failure;
              events.push('commit');
            },
          },
        },
        federation: {
          applyReverseMessagePageInTransaction: apply,
          finalizeReverseMessageWindowInTransaction: finalize,
        },
      });
      try {
        const result = executor.commit(
          source,
          {
            authorizationEpoch: 7,
            gapId: 12n,
            nextBeforeSeq: 40,
            throughSeq: 40,
            messageSeqOffset: 8,
          },
          true,
          batch,
        );
        if (rollback) {
          await expect(result).rejects.toBe(failure);
          expect(publish).not.toHaveBeenCalled();
          expect(events).toEqual(['facts', 'finalize', 'progress']);
        } else {
          await result;
          expect(events).toEqual([
            'facts',
            'finalize',
            'progress',
            'commit',
            'publish',
          ]);
        }
      } finally {
        progress.mockRestore();
      }
    },
  );

  it('includes mirror receipts during an authoritative reverse scan', async () => {
    const { source } = harness();
    if (source.kind !== 'GROUP') throw new Error('expected group fixture');
    source.localGroupAuthority = true;
    const fetch = vi.fn().mockResolvedValue({
      data: { messages: [], scannedThrough: 40, hasMore: false },
    });
    const executor = Object.create(
      FederationThreadReverseRoundExecutorService.prototype,
    );
    Object.assign(executor, { threadResources: { fetch } });
    await executor.fetchMessages(source, {
      before: 100,
      through: 40,
      take: 20,
    });
    expect(fetch).toHaveBeenCalledWith(
      31,
      '/s2s/v1/messages?account=%21group&before=100&through=40&take=20&includeSelf=true',
      'origin.test',
      16 * 1024 * 1024,
    );
  });
  it('executes one group gap without changing wire boundaries', async () => {
    const { executor, fetchMessages, commit, source, batch } = harness();

    await expect(
      executor.run(31, source.peerDomain, 12, 20),
    ).resolves.toMatchObject({
      beforeSeq: 100,
      throughSeq: 40,
      batchOldestSeq: 40,
      closesReverseHistory: true,
    });
    expect(fetchMessages).toHaveBeenCalledWith(source, {
      threadId: 31,
      peerDomain: source.peerDomain,
      before: 100,
      through: 40,
      take: 20,
    });
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
    );
  });

  it('executes P2P history without profile reverse queries', async () => {
    const { executor, commit } = harness('P2P');
    await expect(executor.run(31, 'peer.test', 12)).resolves.toBeDefined();
    expect(commit).toHaveBeenCalledOnce();
  });
});
