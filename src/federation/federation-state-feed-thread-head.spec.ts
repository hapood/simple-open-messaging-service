import { afterEach, describe, expect, it, vi } from 'vitest';
import { FederationStateFeedConsumerService } from './federation-state-feed-consumer.service.js';
import { FederationThreadSyncStateService } from './federation-thread-sync-state.service.js';

vi.mock('../business/shared/locks/thread-content-lock.js', async (original) => ({
  ...(await original<
    typeof import('../business/shared/locks/thread-content-lock.js')
  >()),
  acquireThreadContentLockInTx: vi.fn(async () => ({ threadId: 31 })),
}));

afterEach(() => vi.restoreAllMocks());

describe('State Feed content heads respect relationship initialization', () => {
  it.each([true, false])(
    'handles an empty head with initialized=%s',
    async (initialized) => {
      const update = vi
        .spyOn(FederationThreadSyncStateService, 'updateThreadHeadInTx')
        .mockResolvedValue(initialized);
      const initialize = vi.spyOn(
        FederationThreadSyncStateService,
        'reconcileRelationshipAuthorizationInTx',
      );
      const service = Object.create(
        FederationStateFeedConsumerService.prototype,
      ) as FederationStateFeedConsumerService;
      Object.assign(service, {
        resolveStateFeedTargetInTransaction: vi.fn(async () => ({
          threadId: 31,
          reverseEnabled: true,
        })),
      });
      const tx = { execute: vi.fn(async () => ({ rows: [] })) };
      const applied = service.applyPageInTx(tx as never, 'peer.test', 7, {
        items: [
          {
            account: 'alice',
            peerAccount: 'bob',
            eventType: 'THREAD_CONTENT_HEAD',
            feedId: '1',
            body: { messageEndSeq: 0, tombstoneEndSeq: 0 },
          },
        ],
        scannedThrough: '1',
        stateFeedEndId: '1',
        hasMore: false,
      });
      if (initialized) {
        expect((await applied).threadRoundWakes).toEqual([
          {
            threadId: 31,
            namespaceId: 7,
            peerDomain: 'peer.test',
            direction: 'forward',
          },
        ]);
      } else {
        await expect(applied).rejects.toThrow(
          'no initialized current-epoch synchronization state',
        );
      }
      expect(update).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({
          messageTargetSeq: 0,
          deletionTargetSeq: 0,
        }),
      );
      expect(initialize).not.toHaveBeenCalled();
    },
  );
});
