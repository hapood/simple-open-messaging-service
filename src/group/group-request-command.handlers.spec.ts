import { describe, expect, it, vi } from 'vitest';
import type { DomainCommand } from '../domain-command/domain-command.types.js';
import {
  AcceptGroupInvitationCommandHandler,
  AcceptGroupJoinRequestCommandHandler,
  InviteGroupMemberCommandHandler,
  RejectGroupJoinRequestCommandHandler,
  RevokeGroupInvitationCommandHandler,
} from './group-request-command.handlers.js';

function command(
  payload: Record<string, unknown>,
  commandType = 'TEST',
): DomainCommand {
  return {
    id: 1n,
    parentCommandId: null,
    aggregateType: 'GROUP',
    aggregateKey: 'group',
    commandType,
    actorUserId: 7,
    payload,
    progressCursor: null,
    status: 'PROCESSING',
    resultCode: null,
    lastError: null,
    createdAt: new Date(),
    startedAt: new Date(),
    completedAt: null,
  };
}

describe('group request command handlers', () => {
  const dispatcher = { register: vi.fn() };

  it('executes a validated group-member invitation', async () => {
    const execution = { inviteMember: vi.fn().mockResolvedValue(undefined) };
    const handler = new InviteGroupMemberCommandHandler(
      dispatcher as never,
      {} as never,
      execution as never,
    );

    await handler.execute(command({ threadId: 10, targetUserId: 8 }));

    expect(execution.inviteMember).toHaveBeenCalledWith(7, 10, 8);
  });

  it.each([
    [AcceptGroupJoinRequestCommandHandler, 'ACCEPTED'],
    [RejectGroupJoinRequestCommandHandler, 'REVOKED'],
  ] as const)(
    'executes the persisted join-request decision',
    async (Type, decision) => {
      const groups = {
        handleJoinRequest: vi.fn().mockResolvedValue(undefined),
      };
      const handler = new Type(dispatcher as never, groups as never);

      await handler.execute(
        command({ threadId: 10, requestId: '42', memberUserId: 8 }),
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
    const handler = new RevokeGroupInvitationCommandHandler(
      dispatcher as never,
      groups as never,
    );

    await handler.execute(
      command({ threadId: 10, requestId: '42', memberUserId: 8 }),
    );
    await expect(
      handler.execute(
        command({ threadId: 10, requestId: 'invalid', memberUserId: 8 }),
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
    const handler = new AcceptGroupInvitationCommandHandler(
      dispatcher as never,
      {} as never,
      federation as never,
    );

    await handler.execute(command({ threadId: 10 }));

    expect(federation.acceptGroupRequest).toHaveBeenCalledWith(10, 7);
  });
});
