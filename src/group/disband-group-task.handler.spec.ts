import { describe, expect, it, vi } from 'vitest';
import { DurableTaskDispatcherService } from '../durable-task/durable-task-dispatcher.service.js';
import type { DurableTask } from '../durable-task/durable-task.types.js';
import { DisbandGroupTaskHandler } from './disband-group-task.handler.js';
import { RevokeDissolvedGroupMemberTaskHandler } from './revoke-dissolved-group-member-task.handler.js';

const parent = {
  id: 10n,
  parentTaskId: null,
  kind: 'MUTATION',
  scopeType: 'GROUP',
  scopeKey: 'group-key',
  taskType: 'DISBAND_GROUP',
  actorUserId: 7,
  payload: { threadId: 12 },
  checkpoint: {},
  coalescingKey: null,
  supersededByTaskId: null,
  status: 'PROCESSING',
  resultCode: null,
  lastError: null,
  createdAt: new Date(),
  startedAt: new Date(),
  completedAt: null,
} satisfies DurableTask;

describe('group disband task handlers', () => {
  it('marks the group terminal and admits members until enumeration is complete', async () => {
    const dispatcher = new DurableTaskDispatcherService();
    const markGroupDissolved = vi
      .fn()
      .mockResolvedValue({ transitioned: true });
    const insertNextMember = vi
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const handler = new DisbandGroupTaskHandler(
      dispatcher,
      { markGroupDissolved } as never,
      { insertNextMember } as never,
    );
    handler.onModuleInit();

    await dispatcher.execute(parent);

    expect(markGroupDissolved).toHaveBeenCalledWith({
      threadId: 12,
      operatorUserId: 7,
    });
    expect(insertNextMember).toHaveBeenCalledTimes(3);
    expect(insertNextMember).toHaveBeenCalledWith(parent, 12);
  });

  it('routes a parent-linked child to one member revoke transaction', async () => {
    const dispatcher = new DurableTaskDispatcherService();
    const revokeDissolvedGroupMember = vi.fn().mockResolvedValue(undefined);
    const handler = new RevokeDissolvedGroupMemberTaskHandler(dispatcher, {
      revokeDissolvedGroupMember,
    } as never);
    handler.onModuleInit();
    const child = {
      ...parent,
      id: 11n,
      parentTaskId: 10n,
      taskType: 'REVOKE_DISSOLVED_GROUP_MEMBER',
      payload: { threadId: 12, memberUserId: 9 },
    } satisfies DurableTask;

    await dispatcher.execute(child);

    expect(revokeDissolvedGroupMember).toHaveBeenCalledWith({
      threadId: 12,
      memberUserId: 9,
    });
  });
});
