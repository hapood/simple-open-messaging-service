import { describe, it, expect, vi } from 'vitest';
import { RevokeUserRelationshipTaskHandler } from './revoke-user-relationship-task.handler.js';
import type { DurableTask } from '../durable-task/durable-task.types.js';

describe('user relationship revocation', () => {
  it.each(['INCOMING_PENDING', 'OUTGOING_PENDING'])(
    'preserves the local %s request closure branch',
    async (status) => {
      const local = { reject: vi.fn(), revoke: vi.fn() };
      const handler = new RevokeUserRelationshipTaskHandler(
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {
          friendRelationshipStatuses: vi.fn().mockResolvedValue([{ status }]),
        } as never,
        local as never,
        {} as never,
        {} as never,
        {} as never,
      );
      await handler.execute({
        kind: 'MUTATION',
        scopeType: 'USER_PAIR',
        actorUserId: 7,
        payload: { peerUserId: 8 },
      } as DurableTask);
      expect(
        status === 'INCOMING_PENDING' ? local.reject : local.revoke,
      ).toHaveBeenCalledExactlyOnceWith(8, 7);
      expect(
        status === 'INCOMING_PENDING' ? local.revoke : local.reject,
      ).not.toHaveBeenCalled();
    },
  );

  it.each(['friend', '!group'])(
    'routes addressed %s revocation through the existing execution service',
    async (account) => {
      const remote = { revoke: vi.fn() };
      const group = { revoke: vi.fn() };
      const handler = new RevokeUserRelationshipTaskHandler(
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        remote as never,
        group as never,
        {} as never,
      );
      await handler.execute({
        kind: 'MUTATION',
        scopeType: account.startsWith('!') ? 'GROUP' : 'USER_PAIR',
        actorUserId: 7,
        payload: { account, domain: 'peer.test' },
      } as DurableTask);
      expect(
        account.startsWith('!') ? group.revoke : remote.revoke,
      ).toHaveBeenCalledExactlyOnceWith({
        actorUserId: 7,
        account,
        domain: 'peer.test',
      });
    },
  );

  it('executes an automatic revoke for the relationship author, not the system operator', async () => {
    const endP2P = vi.fn().mockResolvedValue({ statePeers: [] });
    const handler = new RevokeUserRelationshipTaskHandler(
      {} as never,
      {
        db: {
          query: {
            messageThread: {
              findFirst: vi.fn().mockResolvedValue({ type: 'P2P' }),
            },
          },
        },
      } as never,
      { endP2P } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { emit: vi.fn() } as never,
    );
    await handler.execute({
      kind: 'MUTATION',
      scopeType: 'USER_PAIR',
      actorUserId: 99,
      payload: {
        threadId: 12,
        intentAuthorUserId: 7,
        expectedAuthorizationEpoch: 8,
      },
    } as DurableTask);
    expect(endP2P).toHaveBeenCalledExactlyOnceWith(12, 7, 8, 99);
  });

  it.each(['P2P', 'GROUP'] as const)(
    'uses the existing %s mutation branch',
    async (type) => {
      const participants = {
        endP2P: vi.fn().mockResolvedValue({ statePeers: [] }),
      };
      const groups = { leaveGroup: vi.fn().mockResolvedValue(undefined) };
      const handler = new RevokeUserRelationshipTaskHandler(
        {} as never,
        {
          db: {
            query: {
              messageThread: {
                findFirst: vi.fn().mockResolvedValue({
                  type,
                  authorityNamespaceId: 0,
                  groupDomain: type === 'GROUP' ? 'local' : null,
                }),
              },
            },
          },
        } as never,
        participants as never,
        groups as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        { emit: vi.fn() } as never,
      );
      await handler.execute({
        kind: 'MUTATION',
        scopeType: type === 'P2P' ? 'USER_PAIR' : 'GROUP',
        actorUserId: 7,
        payload: { threadId: 12 },
      } as DurableTask);
      if (type === 'P2P') {
        expect(participants.endP2P).toHaveBeenCalledWith(
          12,
          7,
          undefined,
          7,
        );
        expect(groups.leaveGroup).not.toHaveBeenCalled();
      } else {
        expect(groups.leaveGroup).toHaveBeenCalledWith({
          threadId: 12,
          userId: 7,
        });
        expect(participants.endP2P).not.toHaveBeenCalled();
      }
    },
  );
});
