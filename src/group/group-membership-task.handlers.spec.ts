import { describe, expect, it, vi } from 'vitest';
import type { DurableTask } from '../durable-task/durable-task.types.js';
import {
  KickGroupMemberTaskHandler,
  LeaveGroupTaskHandler,
  SetGroupMemberRoleTaskHandler,
  TransferGroupOwnershipTaskHandler,
} from './group-membership-task.handlers.js';

function task(payload: Record<string, unknown>): DurableTask {
  return {
    id: 1n,
    kind: 'MUTATION',
    scopeType: 'GROUP',
    scopeKey: 'group',
    taskType: 'TEST',
    actorUserId: 7,
    payload,
    checkpoint: {},
    coalescingKey: null,
    status: 'PROCESSING',
    resultCode: null,
    lastError: null,
    createdAt: new Date(),
    startedAt: new Date(),
    completedAt: null,
  };
}

describe('group membership task handlers', () => {
  const dispatcher = { register: vi.fn() };

  it('executes a member leave with task-time role validation', async () => {
    const groups = { leaveGroup: vi.fn().mockResolvedValue(undefined) };
    const handler = new LeaveGroupTaskHandler(
      dispatcher as never,
      groups as never,
    );

    await handler.execute(task({ threadId: 10 }));

    expect(groups.leaveGroup).toHaveBeenCalledWith({
      userId: 7,
      threadId: 10,
    });
  });

  it('executes kick and ownership transfer against the persisted target', async () => {
    const groups = {
      kickMember: vi.fn().mockResolvedValue(undefined),
      transferOwnership: vi.fn().mockResolvedValue(undefined),
    };
    const kick = new KickGroupMemberTaskHandler(
      dispatcher as never,
      groups as never,
    );
    const transfer = new TransferGroupOwnershipTaskHandler(
      dispatcher as never,
      groups as never,
    );
    const input = task({ threadId: 10, targetUserId: 8 });

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
    const handler = new SetGroupMemberRoleTaskHandler(
      dispatcher as never,
      groups as never,
    );

    await handler.execute(
      task({ threadId: 10, targetUserId: 8, role: 'ADMIN' }),
    );
    await expect(
      handler.execute(task({ threadId: 10, targetUserId: 8, role: 'OWNER' })),
    ).rejects.toThrow('invalid role');
    expect(groups.setRole).toHaveBeenCalledOnce();
  });
});
