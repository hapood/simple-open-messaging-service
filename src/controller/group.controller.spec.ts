import { describe, expect, it, vi } from 'vitest';
import { GroupController } from './group.controller.js';

describe('group invitation admission', () => {
  it('normalizes the local public domain and deduplicates equivalent addresses', async () => {
    const execute = vi.fn().mockResolvedValue({ status: 'APPLIED' });
    const controller = Object.create(
      GroupController.prototype,
    ) as GroupController;
    Object.assign(controller, {
      federationService: { ourDomain: 'local.test' },
      groupIntents: { execute },
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
    expect(execute).toHaveBeenCalledExactlyOnceWith({
      threadId: 7,
      managerUserId: 3,
      decision: 'REQUESTED',
      target: { account: 'friend', domain: 'local' },
    });
    expect(result).toEqual({
      invited: [{ account: 'friend', domain: 'local' }],
      skipped: [],
    });
  });

  it('returns an expected invitation refusal as target data', async () => {
    const controller = Object.create(
      GroupController.prototype,
    ) as GroupController;
    Object.assign(controller, {
      federationService: { ourDomain: 'local.test' },
      groupIntents: {
        execute: vi.fn().mockResolvedValue({
          status: 'REJECTED',
          reason: 'GROUP_DISSOLVED',
          code: 'GROUP_DISSOLVED',
          message: 'group has been dissolved',
        }),
      },
    });
    await expect(
      controller.inviteUsers(
        {
          user: { userId: 3 },
          threadAccess: { threadId: 7, participant: { role: 'OWNER' } },
        } as never,
        { groupId: 7, users: [{ account: 'friend', domain: 'local' }] },
      ),
    ).resolves.toEqual({
      invited: [],
      skipped: [
        {
          account: 'friend',
          domain: 'local',
          reason: 'GROUP_DISSOLVED',
          code: 'GROUP_DISSOLVED',
          message: 'group has been dissolved',
        },
      ],
    });
  });
});

describe('group revocation admission', () => {
  it('accepts an existing invitation in the member-authored transaction', async () => {
    const execute = vi.fn().mockResolvedValue({ status: 'APPLIED' });
    const controller = Object.create(
      GroupController.prototype,
    ) as GroupController;
    Object.assign(controller, { memberIntents: { execute } });

    await expect(
      controller.joinRequestedGroup({ user: { userId: 3 } } as never, {
        groupId: 10,
      }),
    ).resolves.toEqual({ status: 'APPLIED' });
    expect(execute).toHaveBeenCalledExactlyOnceWith({
      threadId: 10,
      memberUserId: 3,
      decision: 'ACCEPTED',
    });
  });

  it('executes join-request acceptance in the group-authored transaction', async () => {
    const execute = vi.fn().mockResolvedValue({ status: 'APPLIED' });
    const controller = Object.create(
      GroupController.prototype,
    ) as GroupController;
    Object.assign(controller, { groupIntents: { execute } });

    await expect(
      controller.acceptJoinRequest(
        { user: { userId: 3 }, threadAccess: { threadId: 10 } } as never,
        { account: 'member', domain: 'peer.test' } as never,
      ),
    ).resolves.toEqual({ status: 'APPLIED' });
    expect(execute).toHaveBeenCalledExactlyOnceWith({
      threadId: 10,
      target: { account: 'member', domain: 'peer.test' },
      scope: 'APPLICATION',
      managerUserId: 3,
      decision: 'ACCEPTED',
    });
  });

  it.each([
    ['rejectJoinRequest', 'APPLICATION'],
    ['revokeInvitation', 'INVITATION'],
    ['kickMember', 'MEMBER'],
  ] as const)(
    'executes the group-authored business transaction directly for %s',
    async (method, scope) => {
      const execute = vi.fn().mockResolvedValue({ status: 'APPLIED' });
      const controller = Object.create(
        GroupController.prototype,
      ) as GroupController;
      Object.assign(controller, {
        groupIntents: { execute },
      });
      const result = await controller[method](
        { user: { userId: 3 }, threadAccess: { threadId: 10 } } as never,
        { account: ' Member ', domain: ' PEER.TEST ' } as never,
      );
      expect(execute).toHaveBeenCalledExactlyOnceWith(
        {
          threadId: 10,
          managerUserId: 3,
          decision: 'REVOKED',
          scope,
          target: { account: 'member', domain: 'peer.test' },
        },
      );
      expect(result).toEqual({ status: 'APPLIED' });
    },
  );
});
