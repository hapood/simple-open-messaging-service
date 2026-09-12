import { describe, expect, it, vi } from 'vitest';
import type { DatabaseTransaction } from '../database/database.service.js';
import { FederationStateFeedConsumerService } from './federation-state-feed-consumer.service.js';
import type { PeerStateFeedPage } from './peer-state-feed.service.js';

describe('incoming group relationship allocator ordering', () => {
  it.each(['REQUESTED', 'ACCEPTED', 'REVOKED'] as const)(
    'locks the peer allocator before projecting a member %s intent',
    async (status) => {
      const order: string[] = [];
      const projectionBoundary = new Error(
        'stop at client projection boundary',
      );
      const lockTargetsInTx = vi.fn(async () => {
        order.push('peer');
      });
      const service = Object.create(
        FederationStateFeedConsumerService.prototype,
      ) as FederationStateFeedConsumerService;
      Object.assign(service, {
        relationshipTasks: { deferInTx: vi.fn().mockResolvedValue(false) },
        reverseRevokes: {
          enqueueGroupInTx: vi.fn(async () => {
            order.push('task');
          }),
        },
        config: { domain: 'local.test' },
        relationshipIntents: {
          applyRemoteGroupIntentInTx: vi.fn(async () => {
            order.push('group');
            return {
              changed: true,
              wasActive: true,
              shouldBeActive: status === 'ACCEPTED',
            };
          }),
        },
        stateFeed: { lockTargetsInTx },
        relationshipMutations: {
          writeGroupRequestEffectsInTx: vi.fn(async () => {
            order.push('client');
            throw projectionBoundary;
          }),
        },
      });
      const limit = vi
        .fn()
        .mockResolvedValueOnce([{ id: 8, account: '!group' }])
        .mockResolvedValueOnce([{ id: 9 }]);
      const tx = {
        execute: vi.fn().mockResolvedValue({ rows: [] }),
        select: vi.fn(() => ({ from: () => ({ where: () => ({ limit }) }) })),
        query: {
          messageThread: { findFirst: vi.fn().mockResolvedValue({ id: 10 }) },
        },
      } as unknown as DatabaseTransaction;
      const now = Date.now();
      const page: PeerStateFeedPage = {
        items: [
          {
            account: 'member',
            peerAccount: '!group',
            eventType: 'RELATIONSHIP_INTENT',
            feedId: '1',
            body: {
              status,
              profileRev: 0,
              messageEndSeq: 0,
              tombstoneEndSeq: 0,
              note: '',
              requestedAt: status === 'REVOKED' ? null : now,
              expiresAt: status === 'REQUESTED' ? now + 60_000 : null,
            },
          },
        ],
        scannedThrough: '1',
        stateFeedEndId: '1',
        hasMore: false,
      };
      await expect(
        service.applyPageInTx(tx, 'peer.test', 3, page),
      ).rejects.toBe(projectionBoundary);
      expect(order).toEqual(
        status === 'REVOKED'
          ? ['group', 'task', 'peer', 'client']
          : ['group', 'peer', 'client'],
      );
      expect(lockTargetsInTx).toHaveBeenCalledWith(tx, [
        { peerDomain: 'peer.test', namespaceId: 3 },
      ]);
    },
  );
});
