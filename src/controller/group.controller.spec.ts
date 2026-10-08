import { describe, expect, it, vi } from 'vitest';
import { GroupController } from './group.controller.js';

describe('group invitation admission', () => {
  it('normalizes accounts and deduplicates by account and namespace', async () => {
    const execute = vi.fn().mockResolvedValue({ status: 'APPLIED' });
    const controller = Object.create(
      GroupController.prototype,
    ) as GroupController;
    Object.assign(controller, {
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
          { account: 'Friend', namespaceId: 0 },
          { account: 'friend', namespaceId: 0 },
          { account: 'friend', namespaceId: 7 },
        ],
      },
    );
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenNthCalledWith(1, {
      threadId: 7,
      managerUserId: 3,
      decision: 'REQUESTED',
      target: { account: 'friend', namespaceId: 0 },
    });
    expect(execute).toHaveBeenNthCalledWith(2, {
      threadId: 7,
      managerUserId: 3,
      decision: 'REQUESTED',
      target: { account: 'friend', namespaceId: 7 },
    });
    expect(result).toEqual({
      invited: [
        { account: 'friend', namespaceId: 0 },
        { account: 'friend', namespaceId: 7 },
      ],
      skipped: [],
    });
  });

  it('returns an expected invitation refusal as target data', async () => {
    const controller = Object.create(
      GroupController.prototype,
    ) as GroupController;
    Object.assign(controller, {
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
        { groupId: 7, users: [{ account: 'friend', namespaceId: 0 }] },
      ),
    ).resolves.toEqual({
      invited: [],
      skipped: [
        {
          account: 'friend',
          namespaceId: 0,
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
        { account: 'member', namespaceId: 5 } as never,
      ),
    ).resolves.toEqual({ status: 'APPLIED' });
    expect(execute).toHaveBeenCalledExactlyOnceWith({
      threadId: 10,
      target: { account: 'member', namespaceId: 5 },
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
        { account: ' Member ', namespaceId: 5 } as never,
      );
      expect(execute).toHaveBeenCalledExactlyOnceWith({
        threadId: 10,
        managerUserId: 3,
        decision: 'REVOKED',
        scope,
        target: { account: 'member', namespaceId: 5 },
      });
      expect(result).toEqual({ status: 'APPLIED' });
    },
  );
});
