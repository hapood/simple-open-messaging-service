import { describe, expect, it, vi } from 'vitest';
import { FederatedRelationshipRequestTaskExecutionService } from './federated-relationship-request-task-execution.service.js';
import { FederatedGroupTaskExecutionService } from './federated-group-task-execution.service.js';

describe('federated task execution network boundary', () => {
  it.each([true, false])(
    'writes a friend request with created=%s and charges both new and refreshed requests',
    async (created) => {
      const pushStateFeedDomains = vi.fn().mockResolvedValue(undefined);
      const createFederatedRelationshipRequest = vi.fn(
        async (
          _actorUserId: number,
          _account: string,
          _domain: string,
          _note: string,
          _snapshot: unknown,
          write: (
            tx: unknown,
            state: { namespaceId: number; created: boolean },
          ) => Promise<void>,
        ) => write({}, { namespaceId: 4, created }),
      );
      const writeAddressedRelationshipRequestInTx = vi
        .fn()
        .mockResolvedValue(new Map([['peer.test', 3n]]));
      const tick = vi.fn();
      const service = new FederatedRelationshipRequestTaskExecutionService(
        { createFederatedRelationshipRequest } as never,
        { writeAddressedRelationshipRequestInTx } as never,
        { pushStateFeedDomains } as never,
        { tick } as never,
        { notifyFeedUpdates: vi.fn() } as never,
      );

      await service.send({
        actorUserId: 1,
        account: 'bob',
        domain: 'peer.test',
        note: '',
        displayName: 'Bob',
      });

      expect(writeAddressedRelationshipRequestInTx).toHaveBeenCalled();
      expect(tick).toHaveBeenCalledTimes(1);
      expect(pushStateFeedDomains).toHaveBeenCalledWith(
        expect.objectContaining({}),
      );
    },
  );

  it('writes a group join request without initiating peer recognition', async () => {
    const requestFederatedGroupJoin = vi.fn().mockResolvedValue(undefined);
    const service = new FederatedGroupTaskExecutionService(
      { requestFederatedGroupJoin } as never,
      { tick: vi.fn() } as never,
    );

    await service.request({
      actorUserId: 1,
      account: '!group',
      domain: 'peer.test',
      note: '',
      displayName: 'Group',
    });

    expect(requestFederatedGroupJoin).toHaveBeenCalled();
  });

  it('accepts a group invitation through the dedicated group intent path', async () => {
    const acceptAddressedGroupInvitation = vi.fn().mockResolvedValue(undefined);
    const service = new FederatedGroupTaskExecutionService(
      { acceptAddressedGroupInvitation } as never,
      { tick: vi.fn() } as never,
    );

    await service.accept({
      actorUserId: 1,
      account: '!group',
      domain: 'peer.test',
    });

    expect(acceptAddressedGroupInvitation).toHaveBeenCalledWith(1, {
      account: '!group',
      domain: 'peer.test',
    });
  });
});
