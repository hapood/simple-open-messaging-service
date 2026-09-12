import { describe, expect, it, vi } from 'vitest';
import { DurableTaskDispatcherService } from '../durable-task/durable-task-dispatcher.service.js';
import type { DurableTask } from '../durable-task/durable-task.types.js';
import { DisbandGroupTaskHandler } from './disband-group-task.handler.js';
import { ForceRevokeGroupMemberTaskHandler } from './force-revoke-group-member-task.handler.js';
import { RevokeForbiddenGroupTaskHandler } from './revoke-forbidden-group-task.handler.js';

const parent = {
  id: 10n,
  kind: 'MUTATION',
  scopeType: 'GROUP',
  scopeKey: 'group-key',
  taskType: 'DISBAND_GROUP',
  actorUserId: 7,
  payload: { threadId: 12 },
  checkpoint: {},
  coalescingKey: null,
  status: 'PROCESSING',
  resultCode: null,
  lastError: null,
  createdAt: new Date(),
  startedAt: new Date(),
  completedAt: null,
} satisfies DurableTask;

describe('group disband task handlers', () => {
  it('drains forbidden cleanup admissions without waiting for children', async () => {
    const dispatcher = new DurableTaskDispatcherService();
    const insertNextMember = vi
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const handler = new RevokeForbiddenGroupTaskHandler(dispatcher, {
      insertNextMember,
    } as never);
    handler.onModuleInit();
    const task = {
      ...parent,
      taskType: 'REVOKE_FORBIDDEN_GROUP',
      payload: {
        threadId: 12,
        peerDomain: 'peer.test',
        namespaceId: 5,
        expectedAuthorizationEpoch: 8,
      },
    };
    await expect(dispatcher.execute(task)).resolves.toBeUndefined();
    expect(insertNextMember).toHaveBeenCalledTimes(3);
    expect(insertNextMember).toHaveBeenCalledWith(task, 12);
    handler.onModuleDestroy();
    expect(dispatcher.supportedTaskTypes).toHaveLength(0);
  });

  it('routes denial children to the existing intent writers rather than dissolution', async () => {
    const revokeForbiddenMember = vi.fn().mockResolvedValue(undefined);
    const execute = vi.fn();
    const handler = new ForceRevokeGroupMemberTaskHandler(
      new DurableTaskDispatcherService(),
      { execute } as never,
      { revokeForbiddenMember } as never,
    );
    const task = {
      ...parent,
      taskType: 'FORCE_REVOKE_GROUP_MEMBER',
      payload: {
        threadId: 12,
        memberUserId: 7,
        direction: 'MEMBER',
        peerDomain: 'peer.test',
        namespaceId: 5,
        expectedAuthorizationEpoch: 8,
      },
    };
    await handler.execute(task);
    expect(revokeForbiddenMember).toHaveBeenCalledWith(task);
    expect(execute).not.toHaveBeenCalled();
  });

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

  it('routes a forced child to one member revoke transaction', async () => {
    const dispatcher = new DurableTaskDispatcherService();
    const execute = vi.fn().mockResolvedValue({ transitioned: true });
    const handler = new ForceRevokeGroupMemberTaskHandler(
      dispatcher,
      { execute } as never,
      {} as never,
    );
    handler.onModuleInit();
    const child = {
      ...parent,
      id: 11n,
      taskType: 'FORCE_REVOKE_GROUP_MEMBER',
      payload: {
        threadId: 12,
        memberUserId: { account: 'member', domain: 'local', namespaceId: 0 },
      },
    } satisfies DurableTask;

    await dispatcher.execute(child);

    expect(execute).toHaveBeenCalledWith({
      threadId: 12,
      memberAddress: { account: 'member', domain: 'local', namespaceId: 0 },
    });
  });
});
