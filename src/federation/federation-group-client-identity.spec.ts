import { describe, expect, it, vi } from 'vitest';
import { FederationStateFeedConsumerService } from './federation-state-feed-consumer.service.js';
import { RelationshipService } from '../relationship/relationship.service.js';

describe('group relationship client identities', () => {
  it.each(['REQUESTED', 'ACCEPTED', 'REVOKED'] as const)(
    'projects an incoming group %s with the local member sentinel',
    async (status) => {
      const writeInTx = vi.fn().mockResolvedValue(85);
      const service = Object.create(
        FederationStateFeedConsumerService.prototype,
      );
      const group = { id: 28, account: '!group', profileRev: 0 };
      Object.assign(service, {
        reverseRevokes: { enqueueGroupInTx: vi.fn(async () => undefined) },
        config: { domain: 'bravo.test' },
        clientStateFeed: { writeInTx },
        relationshipIntents: {
          applyRemoteGroupIntentInTx: vi.fn().mockResolvedValue({
            changed: true,
            shouldBeActive: status === 'ACCEPTED',
            publishAccepted: false,
          }),
        },
        stateFeed: { lockTargetsInTx: vi.fn() },
        groupRelationships: { syncActiveInTx: vi.fn() },
        ensureFederatedGroupRequestShellInTx: vi.fn().mockResolvedValue({
          groupId: 28,
          threadId: 28,
        }),
      });
      const limit = vi.fn();
      if (status === 'REQUESTED')
        limit.mockResolvedValueOnce([{ id: 2, account: 'member' }]);
      else
        limit.mockResolvedValueOnce([group]).mockResolvedValueOnce([{ id: 2 }]);
      const tx = {
        execute: vi.fn().mockResolvedValue({ rows: [] }),
        select: () => ({
          from: () => ({
            where: () => ({
              limit,
              orderBy: () => [{ id: 2, account: 'member' }],
            }),
          }),
        }),
        query: {
          messageThread: { findFirst: vi.fn().mockResolvedValue({ id: 28 }) },
        },
      };
      const now = Date.now();
      await service.applyPageInTx(tx, 'alpha.test', 1, {
        items: [
          {
            account: '!group',
            peerAccount: 'member',
            eventType: 'RELATIONSHIP_INTENT',
            feedId: '1',
            body: {
              status,
              profileRev: 0,
              messageEndSeq: 0,
              tombstoneEndSeq: 0,
              note: '',
              requestedAt: now,
              expiresAt: status === 'REQUESTED' ? now + 60_000 : null,
            },
          },
        ],
        scannedThrough: '1',
        stateFeedEndId: '1',
        hasMore: false,
      });
      expect(writeInTx).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({
          userId: 2,
          account: '!group',
          domain: 'alpha.test',
          namespaceId: 1,
          subjectAccount: 'member',
          subjectDomain: 'local',
          body: expect.objectContaining({ status, threadId: 28 }),
        }),
      );
    },
  );

  it('projects a hosted group and local member using local on both endpoints', async () => {
    const writeInTx = vi.fn().mockResolvedValue(1);
    const service = Object.create(RelationshipService.prototype);
    Object.assign(service, {
      config: { domain: 'bravo.test' },
      clientStateFeed: { writeInTx },
    });
    const state = {
      groupId: 28,
      account: '!group',
      domain: 'local',
      profileRev: 1,
    };
    const tx = {
      select: () => ({
        from: () => ({
          innerJoin: () => ({ where: () => ({ limit: async () => [state] }) }),
        }),
      }),
      query: {
        relationshipIntent: { findFirst: async () => ({ status: 'ACCEPTED' }) },
        account: { findFirst: async () => ({ account: 'member' }) },
      },
    };
    await service.writeGroupRequestClientStateInTx(tx, 28, 2, []);
    expect(writeInTx).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        domain: 'local',
        subjectDomain: 'local',
        namespaceId: 0,
        body: expect.objectContaining({
          group: expect.objectContaining({ domain: 'local' }),
        }),
      }),
    );
  });
});
