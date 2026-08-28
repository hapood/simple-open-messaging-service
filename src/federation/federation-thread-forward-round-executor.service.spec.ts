import { afterEach, describe, expect, it, vi } from 'vitest';
import { FederationThreadForwardRoundExecutorService } from './federation-thread-forward-round-executor.service.js';
import type { FederationThreadForwardRoundDriver } from './federation-thread-forward-round.service.js';
import { FederationThreadSyncStateService } from './federation-thread-sync-state.service.js';

afterEach(() => vi.restoreAllMocks());

describe('FederationThreadForwardRoundExecutorService', () => {
  it('queries one bounded page per branch and commits both positions before publication', async () => {
    const publishMessage = vi.fn().mockResolvedValue(undefined);
    const publishTombstone = vi.fn().mockResolvedValue(undefined);
    const federation = {
      fetchThreadResource: vi
        .fn()
        .mockResolvedValueOnce({
          data: { messages: [], scannedThrough: 60, hasMore: true },
          threadId: 31,
          peerDomain: 'origin.test',
          federationVersion: 2,
          peerToken: {
            domain: 'origin.test',
            resetGeneration: 1,
            rootKeyFingerprint: 'fingerprint',
          },
        })
        .mockResolvedValueOnce({
          data: { tombstones: [], scannedThrough: 9, hasMore: false },
          threadId: 31,
          peerDomain: 'origin.test',
          federationVersion: 2,
          peerToken: {
            domain: 'origin.test',
            resetGeneration: 1,
            rootKeyFingerprint: 'fingerprint',
          },
        }),
      applyForwardMessagePage: vi.fn().mockResolvedValue({
        blockedByPending: false,
        publish: publishMessage,
      }),
      applyForwardTombstonePage: vi.fn().mockResolvedValue({
        publish: publishTombstone,
      }),
    };
    const rounds = {
      run: vi.fn(
        async (
          threadId: number,
          peerDomain: string,
          driver: FederationThreadForwardRoundDriver,
          take: number,
        ) => {
          const [messages] = await Promise.all([
            driver.processMessages({
              threadId,
              peerDomain,
              after: 10,
              through: 100,
              take,
            }),
            driver.processTombstones({
              threadId,
              peerDomain,
              after: 4,
              through: 9,
              maxMessageSeq: 100,
              take,
            }),
          ]);
          expect(publishMessage).not.toHaveBeenCalled();
          expect(publishTombstone).not.toHaveBeenCalled();
          await driver.complete({
            threadId,
            peerDomain,
            messageTargetSeq: 100,
            deletionTargetSeq: 9,
          });
          return {
            messageTargetSeq: 100,
            deletionTargetSeq: 9,
            processedMessages: true,
            processedTombstones: true,
            blockedByPending: messages.blockedByPending,
          };
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

    await executor.run(31, 'origin.test', 50);

    expect(federation.fetchThreadResource).toHaveBeenNthCalledWith(
      1,
      31,
      '/s2s/v1/messages?account=%21group&after=10&through=100&take=50&includeSelf=true',
      'origin.test',
      16 * 1024 * 1024,
    );
    expect(federation.fetchThreadResource).toHaveBeenNthCalledWith(
      2,
      31,
      '/s2s/v1/message-tombstones?account=%21group&after=4&through=9&take=50&includeSelf=true&maxMessageSeq=100',
      'origin.test',
      4 * 1024 * 1024,
    );
    expect(messageAdvance).toHaveBeenCalledWith({}, 31, 'origin.test', 60, 100);
    expect(deletionAdvance).toHaveBeenCalledWith({}, 31, 'origin.test', 9, 9);
    expect(publishMessage).toHaveBeenCalledOnce();
    expect(publishTombstone).toHaveBeenCalledOnce();
  });
});
