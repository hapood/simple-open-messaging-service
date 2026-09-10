import { describe, expect, it, vi } from 'vitest';
import { GroupController } from './group.controller.js';

describe('group invitation admission', () => {
  it('normalizes the local public domain and deduplicates equivalent addresses', async () => {
    const resolve = vi.fn().mockResolvedValue({
      account: 'friend',
      domain: 'local',
      namespaceId: 0,
      threadId: 50,
    });
    const enqueueTask = vi.fn().mockResolvedValue({ taskId: 1n });
    const controller = Object.create(
      GroupController.prototype,
    ) as GroupController;
    Object.assign(controller, {
      groupService: {
        findGroupByThreadId: async () => ({
          group: { account: '!group', domain: 'local' },
        }),
      },
      federationService: { ourDomain: 'local.test' },
      participantService: { findP2PFriendByAddress: resolve },
      durableTasks: { enqueueTask },
    });
    const result = await controller.inviteUsers(
      {
        user: { userId: 3 },
        threadAccess: { threadId: 7, participant: { role: 'OWNER' } },
      } as never,
      {
        groupId: 7,
        users: [
          { account: 'friend', domain: ' LOCAL.TEST ' },
          { account: 'friend', domain: 'local' },
        ],
      },
    );
    expect(resolve).toHaveBeenCalledExactlyOnceWith(3, {
      account: 'friend',
      domain: 'local',
    });
    expect(enqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: {
          threadId: 7,
          targetUserId: { account: 'friend', domain: 'local', namespaceId: 0 },
        },
      }),
    );
    expect(result).toEqual({
      invited: [{ account: 'friend', domain: 'local' }],
      tasks: [
        { account: 'friend', domain: 'local', taskId: '1', status: 'PENDING' },
      ],
      skipped: [],
    });
  });
});

describe('group revocation admission', () => {
  it.each([
    ['rejectJoinRequest', 'REJECT_REQUEST'],
    ['revokeInvitation', 'REVOKE_INVITATION'],
    ['kickMember', 'KICK'],
  ] as const)(
    'records the operator separately from the group author for %s',
    async (method, operation) => {
      const enqueueTask = vi.fn().mockResolvedValue({ taskId: 1n });
      const controller = Object.create(
        GroupController.prototype,
      ) as GroupController;
      Object.assign(controller, {
        groupService: {
          resolveGroupCommandScope: vi
            .fn()
            .mockResolvedValue({ account: '!group', domain: 'local' }),
          resolveGroupRequestCommandScope: vi
            .fn()
            .mockResolvedValue({ memberUserId: 7 }),
          resolveActiveMember: vi.fn().mockResolvedValue(7),
        },
        durableTasks: { enqueueTask },
      });
      await controller[method](
        { user: { userId: 3 }, threadAccess: { threadId: 10 } } as never,
        { requestId: '12' } as never,
      );
      expect(enqueueTask).toHaveBeenCalledWith({
        scope: {
          type: 'GROUP',
          address: { account: '!group', domain: 'local' },
        },
        taskType: 'REVOKE_GROUP_RELATIONSHIP',
        actorUserId: 3,
        payload:
          operation === 'KICK'
            ? { threadId: 10, targetUserId: 7, operation }
            : { threadId: 10, memberUserId: 7, requestId: '12', operation },
      });
    },
  );
});
