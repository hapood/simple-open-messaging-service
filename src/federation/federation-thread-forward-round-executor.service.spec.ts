import { afterEach, describe, expect, it, vi } from 'vitest';
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
    federationVersion: 2,
    peerToken: {
      domain: 'origin.test',
      resetGeneration: 1,
      rootKeyFingerprint: 'fingerprint',
    },
  };
}

function harness() {
  const publishMessage = vi.fn().mockResolvedValue(undefined);
  const publishTombstone = vi.fn().mockResolvedValue(undefined);
  const federation = {
    fetchThreadResource: vi.fn(),
    applyForwardMessagePageInTransaction: vi.fn().mockResolvedValue({
      publish: publishMessage,
    }),
    applyForwardTombstonePageInTransaction: vi.fn().mockResolvedValue({
      publish: publishTombstone,
    }),
  };
  const rounds = {
    runMessages: vi.fn(
      async (
        threadId: number,
        peerDomain: string,
        driver: FederationThreadForwardMessageRoundDriver,
        take: number,
      ) => {
        await driver.process({
          threadId,
          peerDomain,
          after: 10,
          through: 100,
          take,
        });
        await driver.complete({
          threadId,
          peerDomain,
          authorizationEpoch: 4,
          targetSeq: 100,
        });
        return { targetSeq: 100, processed: true };
      },
    ),
    runTombstones: vi.fn(
      async (
        threadId: number,
        peerDomain: string,
        targetSeq: number,
        maxMessageSeq: number,
        driver: FederationThreadForwardTombstoneRoundDriver,
        take: number,
      ) => {
        await driver.process({
          threadId,
          peerDomain,
          after: 4,
          through: targetSeq,
          maxMessageSeq,
          take,
        });
        await driver.complete({
          threadId,
          peerDomain,
          authorizationEpoch: 4,
          targetSeq,
        });
        return { targetSeq, maxMessageSeq, processed: true };
      },
    ),
  };
  const database = {
    db: {
      transaction: vi.fn((callback: (tx: object) => Promise<void>) =>
        callback({}),
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
    .mockResolvedValue(undefined);
  const executor = new FederationThreadForwardRoundExecutorService(
    database as never,
    rounds as never,
    federation as never,
    {
      resolve: vi.fn().mockResolvedValue({
        kind: 'GROUP',
        threadId: 31,
        peerDomain: 'origin.test',
        selector: { account: '!group' },
      }),
    } as never,
  );
  return {
    executor,
    federation,
    database,
    publishMessage,
    publishTombstone,
    messageAdvance,
    deletionAdvance,
    epochLock,
  };
}

describe('FederationThreadForwardRoundExecutorService', () => {
  it('commits a message page and its cursor independently', async () => {
    const h = harness();
    h.federation.fetchThreadResource.mockResolvedValueOnce(
      response({ messages: [], scannedThrough: 60, hasMore: true }),
    );

    await h.executor.runMessages(31, 'origin.test', 50);

    expect(h.federation.fetchThreadResource).toHaveBeenCalledWith(
      31,
      '/s2s/v1/messages?account=%21group&after=10&through=100&take=50&includeSelf=true',
      'origin.test',
      16 * 1024 * 1024,
    );
    expect(h.messageAdvance).toHaveBeenCalledWith(
      {},
      31,
      'origin.test',
      60,
      100,
    );
    expect(h.deletionAdvance).not.toHaveBeenCalled();
    expect(h.epochLock).toHaveBeenCalledWith({}, 31, 4);
    expect(h.publishMessage).toHaveBeenCalledOnce();
    expect(h.publishTombstone).not.toHaveBeenCalled();
  });

  it('commits an independently bounded tombstone page with its frozen cutoff', async () => {
    const h = harness();
    h.federation.fetchThreadResource.mockResolvedValueOnce(
      response({ tombstones: [], scannedThrough: 9, hasMore: false }),
    );

    await h.executor.runTombstones(31, 'origin.test', 9, 42, 50);

    expect(h.federation.fetchThreadResource).toHaveBeenCalledWith(
      31,
      '/s2s/v1/message-tombstones?account=%21group&after=4&through=9&take=50&includeSelf=true&maxMessageSeq=42',
      'origin.test',
      4 * 1024 * 1024,
    );
    expect(h.deletionAdvance).toHaveBeenCalledWith({}, 31, 'origin.test', 9, 9);
    expect(h.messageAdvance).not.toHaveBeenCalled();
    expect(h.epochLock).toHaveBeenCalledWith({}, 31, 4);
    expect(h.publishTombstone).toHaveBeenCalledOnce();
    expect(h.publishMessage).not.toHaveBeenCalled();
  });
});
