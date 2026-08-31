import { describe, expect, it, vi } from 'vitest';
import type { DomainCommand } from '../domain-command/domain-command.types.js';
import {
  KickGroupMemberCommandHandler,
  LeaveGroupCommandHandler,
  SetGroupMemberRoleCommandHandler,
  TransferGroupOwnershipCommandHandler,
} from './group-membership-command.handlers.js';

function command(payload: Record<string, unknown>): DomainCommand {
  return {
    id: 1n,
    parentCommandId: null,
    aggregateType: 'GROUP',
    aggregateKey: 'group',
    commandType: 'TEST',
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

describe('group membership command handlers', () => {
  const dispatcher = { register: vi.fn() };

  it('executes a member leave with command-time role validation', async () => {
    const groups = { leaveGroup: vi.fn().mockResolvedValue(undefined) };
    const handler = new LeaveGroupCommandHandler(
      dispatcher as never,
      groups as never,
    );

    await handler.execute(command({ threadId: 10, deleteData: true }));

    expect(groups.leaveGroup).toHaveBeenCalledWith({
      userId: 7,
      threadId: 10,
      role: null,
      deleteData: true,
    });
  });

  it('executes kick and ownership transfer against the persisted target', async () => {
    const groups = {
      kickMember: vi.fn().mockResolvedValue(undefined),
      transferOwnership: vi.fn().mockResolvedValue(undefined),
    };
    const kick = new KickGroupMemberCommandHandler(
      dispatcher as never,
      groups as never,
    );
    const transfer = new TransferGroupOwnershipCommandHandler(
      dispatcher as never,
      groups as never,
    );
    const input = command({ threadId: 10, targetUserId: 8 });

    await kick.execute(input);
    await transfer.execute(input);

    expect(groups.kickMember).toHaveBeenCalledWith({
      threadId: 10,
      operatorUserId: 7,
      targetUserId: 8,
    });
    expect(groups.transferOwnership).toHaveBeenCalledWith({
      threadId: 10,
      fromUserId: 7,
      toUserId: 8,
    });
  });

  it('accepts only assignable member roles', async () => {
    const groups = { setRole: vi.fn().mockResolvedValue(undefined) };
    const handler = new SetGroupMemberRoleCommandHandler(
      dispatcher as never,
      groups as never,
    );

    await handler.execute(
      command({ threadId: 10, targetUserId: 8, role: 'ADMIN' }),
    );
    await expect(
      handler.execute(
        command({ threadId: 10, targetUserId: 8, role: 'OWNER' }),
      ),
    ).rejects.toThrow('invalid role');
    expect(groups.setRole).toHaveBeenCalledOnce();
  });
});
