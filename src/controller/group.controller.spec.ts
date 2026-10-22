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
          {
            account: 'Friend',
            namespaceId: 0,
            snapshot: { displayName: 'Friend', avatar: null },
          },
          {
            account: 'friend',
            namespaceId: 0,
            snapshot: { displayName: 'Friend', avatar: null },
          },
          {
            account: 'friend',
            namespaceId: 7,
            snapshot: { displayName: 'Remote Friend', avatar: null },
          },
        ],
      },
    );
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenNthCalledWith(1, {
      threadId: 7,
      managerUserId: 3,
      decision: 'REQUESTED',
      snapshot: { displayName: 'Friend', avatar: null },
      target: { account: 'friend', namespaceId: 0 },
    });
    expect(execute).toHaveBeenNthCalledWith(2, {
      threadId: 7,
      managerUserId: 3,
      decision: 'REQUESTED',
      snapshot: { displayName: 'Remote Friend', avatar: null },
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
        {
          groupId: 7,
          users: [
            {
              account: 'friend',
              namespaceId: 0,
              snapshot: { displayName: 'Friend', avatar: null },
            },
          ],
        },
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
  it('accepts an invitation by exact request round through the member state machine', async () => {
    const resolveMemberGroupRound = vi
      .fn()
      .mockResolvedValue({ status: 'RESOLVED', threadId: 10 });
    const execute = vi.fn().mockResolvedValue({ status: 'APPLIED' });
    const controller = Object.create(
      GroupController.prototype,
    ) as GroupController;
    Object.assign(controller, {
      requests: { resolveMemberGroupRound },
      memberIntents: { execute },
    });
    await expect(
      controller.joinRequestedGroup({ user: { userId: 3 } } as never, {
        requestId: '9007199254740993',
      }),
    ).resolves.toEqual({ status: 'OK', threadId: 10 });
    expect(resolveMemberGroupRound).toHaveBeenCalledExactlyOnceWith(
      3,
      '9007199254740993',
      'ACCEPT',
    );
    expect(execute).toHaveBeenCalledExactlyOnceWith(
      { threadId: 10, memberUserId: 3, decision: 'ACCEPTED' },
      { requestDecision: { requestId: 9007199254740993n, decision: 'ACCEPT' } },
    );
  });

  it('preserves the closed stale outcome without driving the state machine', async () => {
    const resolveMemberGroupRound = vi
      .fn()
      .mockResolvedValue({ status: 'STALE_REQUEST' });
    const execute = vi.fn();
    const controller = Object.create(
      GroupController.prototype,
    ) as GroupController;
    Object.assign(controller, {
      requests: { resolveMemberGroupRound },
      memberIntents: { execute },
    });
    await expect(
      controller.joinRequestedGroup({ user: { userId: 3 } } as never, {
        requestId: '42',
      }),
    ).resolves.toEqual({ status: 'STALE_REQUEST' });
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    ['declineGroupInvitation', 'REJECT', 'REVOKED'],
    ['withdrawGroupApplication', 'WITHDRAW', 'REVOKED'],
  ] as const)(
    'settles %s by exact request round through the member state machine',
    async (method, decision, intentDecision) => {
      const resolveMemberGroupRound = vi
        .fn()
        .mockResolvedValue({ status: 'RESOLVED', threadId: 10 });
      const execute = vi.fn().mockResolvedValue({ status: 'APPLIED' });
      const controller = Object.create(
        GroupController.prototype,
      ) as GroupController;
      Object.assign(controller, {
        requests: { resolveMemberGroupRound },
        memberIntents: { execute },
      });
      await expect(
        controller[method]({ user: { userId: 3 } } as never, {
          requestId: '42',
        }),
      ).resolves.toEqual({ status: 'OK', threadId: 10 });
      expect(resolveMemberGroupRound).toHaveBeenCalledExactlyOnceWith(
        3,
        '42',
        decision,
      );
      expect(execute).toHaveBeenCalledExactlyOnceWith(
        { threadId: 10, memberUserId: 3, decision: intentDecision },
        { requestDecision: { requestId: 42n, decision } },
      );
    },
  );

  it.each([
    ['acceptJoinRequest', 'APPLICATION', 'ACCEPT', 'ACCEPTED'],
    ['rejectJoinRequest', 'APPLICATION', 'REJECT', 'REVOKED'],
    ['revokeInvitation', 'INVITATION', 'WITHDRAW', 'REVOKED'],
  ] as const)(
    'routes %s through the group state machine with the exact-round gate',
    async (method, direction, decision, intentDecision) => {
      const resolveManagerGroupRound = vi.fn().mockResolvedValue({
        status: 'RESOLVED',
        member: { account: 'applicant', namespaceId: 0 },
      });
      const execute = vi.fn().mockResolvedValue({ status: 'APPLIED' });
      const controller = Object.create(
        GroupController.prototype,
      ) as GroupController;
      Object.assign(controller, {
        requests: { resolveManagerGroupRound },
        groupIntents: { execute },
      });
      await expect(
        controller[method]({ user: { userId: 3 } } as never, {
          groupId: 10,
          requestId: '42',
        }),
      ).resolves.toEqual({ status: 'OK', threadId: 10 });
      expect(resolveManagerGroupRound).toHaveBeenCalledExactlyOnceWith(
        3,
        10,
        '42',
        direction,
      );
      expect(execute).toHaveBeenCalledExactlyOnceWith(
        {
          threadId: 10,
          managerUserId: 3,
          decision: intentDecision,
          target: { account: 'applicant', namespaceId: 0 },
          scope: direction,
        },
        { requestDecision: { requestId: 42n, decision } },
      );
    },
  );

  it('preserves a stale manager round without driving the state machine', async () => {
    const resolveManagerGroupRound = vi
      .fn()
      .mockResolvedValue({ status: 'STALE_REQUEST' });
    const execute = vi.fn();
    const controller = Object.create(
      GroupController.prototype,
    ) as GroupController;
    Object.assign(controller, {
      requests: { resolveManagerGroupRound },
      groupIntents: { execute },
    });
    await expect(
      controller.rejectJoinRequest({ user: { userId: 3 } } as never, {
        groupId: 10,
        requestId: '42',
      }),
    ).resolves.toEqual({ status: 'STALE_REQUEST' });
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([['kickMember', 'MEMBER']] as const)(
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
