import { describe, expect, it, vi } from 'vitest';
import type { FederationReverseThreadSource } from './federation-reverse-thread-source.js';
import { FederationThreadReverseRoundExecutorService } from './federation-thread-reverse-round-executor.service.js';
import { FederationThreadReverseRoundService } from './federation-thread-reverse-round.service.js';

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
          threadId: 31,
          peerDomain: 'origin.test',
          selector: { account: '!group' },
        }
      : {
          kind: 'P2P',
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
