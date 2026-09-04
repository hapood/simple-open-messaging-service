import { describe, expect, it, vi } from 'vitest';
import type { DurableTask } from '../durable-task/durable-task.types.js';
import {
  AcceptGroupInvitationTaskHandler,
  AcceptGroupJoinRequestTaskHandler,
  InviteGroupMemberTaskHandler,
  RejectGroupJoinRequestTaskHandler,
  RevokeGroupInvitationTaskHandler,
} from './group-request-task.handlers.js';

function task(
  payload: Record<string, unknown>,
  taskType = 'TEST',
): DurableTask {
  return {
    id: 1n,
    parentTaskId: null,
    kind: 'MUTATION',
    scopeType: 'GROUP',
    scopeKey: 'group',
    taskType,
    actorUserId: 7,
    payload,
    checkpoint: {},
    coalescingKey: null,
    supersededByTaskId: null,
    status: 'PROCESSING',
    resultCode: null,
    lastError: null,
    createdAt: new Date(),
    startedAt: new Date(),
    completedAt: null,
  };
}

describe('group request task handlers', () => {
  const dispatcher = { register: vi.fn() };

  it('executes a validated group-member invitation', async () => {
    const execution = { inviteMember: vi.fn().mockResolvedValue(undefined) };
    const handler = new InviteGroupMemberTaskHandler(
      dispatcher as never,
      {} as never,
      execution as never,
    );

    await handler.execute(task({ threadId: 10, targetUserId: 8 }));

    expect(execution.inviteMember).toHaveBeenCalledWith(7, 10, 8);
  });

  it.each([
    [AcceptGroupJoinRequestTaskHandler, 'ACCEPTED'],
    [RejectGroupJoinRequestTaskHandler, 'REVOKED'],
  ] as const)(
    'executes the persisted join-request decision',
    async (Type, decision) => {
      const groups = {
        handleJoinRequest: vi.fn().mockResolvedValue(undefined),
      };
      const handler = new Type(dispatcher as never, groups as never);

      await handler.execute(
        task({ threadId: 10, requestId: '42', memberUserId: 8 }),
      );

      expect(groups.handleJoinRequest).toHaveBeenCalledWith({
        threadId: 10,
        requestId: 42n,
        managerUserId: 7,
        decision,
      });
    },
  );

  it('executes invitation revocation and rejects malformed request ids', async () => {
    const groups = { revokeInvitation: vi.fn().mockResolvedValue(undefined) };
    const handler = new RevokeGroupInvitationTaskHandler(
      dispatcher as never,
      groups as never,
    );

    await handler.execute(
      task({ threadId: 10, requestId: '42', memberUserId: 8 }),
    );
    await expect(
      handler.execute(
        task({ threadId: 10, requestId: 'invalid', memberUserId: 8 }),
      ),
    ).rejects.toThrow('invalid request ID');
    expect(groups.revokeInvitation).toHaveBeenCalledWith({
      threadId: 10,
      requestId: 42n,
      managerUserId: 7,
    });
  });

  it('executes member-side group invitation acceptance', async () => {
    const federation = {
      acceptGroupRequest: vi.fn().mockResolvedValue(undefined),
    };
    const handler = new AcceptGroupInvitationTaskHandler(
      dispatcher as never,
      {} as never,
      federation as never,
    );

    await handler.execute(task({ threadId: 10 }));

    expect(federation.acceptGroupRequest).toHaveBeenCalledWith(10, 7);
  });
});
