import { describe, expect, it, vi } from 'vitest';
import { DurableTaskDispatcherService } from '../durable-task/durable-task-dispatcher.service.js';
import type { DurableTask } from '../durable-task/durable-task.types.js';
import { DisbandGroupTaskHandler } from './disband-group-task.handler.js';
import { DisbandMirrorGroupMembersTaskHandler } from './disband-mirror-group-members-task.handler.js';
import { ForceRevokeGroupMemberTaskHandler } from './force-revoke-group-member-task.handler.js';
import { RevokeForbiddenGroupTaskHandler } from './revoke-forbidden-group-task.handler.js';
import { businessAccountScopeKey } from '../common/locks/account-business-lock.js';

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
    const executeQueryDeniedRevocation = vi
      .fn()
      .mockResolvedValue({ status: 'APPLIED' });
    const execute = vi.fn();
    const handler = new ForceRevokeGroupMemberTaskHandler(
      new DurableTaskDispatcherService(),
      { execute } as never,
      {} as never,
      { executeQueryDeniedRevocation } as never,
      {} as never,
    );
    const task = {
      ...parent,
      scopeKey: businessAccountScopeKey({
        account: '!group',
        domain: 'local',
      }),
      taskType: 'FORCE_REVOKE_GROUP_MEMBER',
      payload: {
        threadId: 12,
        memberUserId: {
          account: 'remote',
          domain: 'peer.test',
          namespaceId: 5,
        },
        direction: 'GROUP',
        peerDomain: 'peer.test',
        namespaceId: 5,
        expectedAuthorizationEpoch: 8,
        groupAccount: '!group',
        groupDomain: 'local',
        groupNamespaceId: 0,
      },
    };
    await handler.execute(task);
    expect(executeQueryDeniedRevocation).toHaveBeenCalledWith({
      threadId: 12,
      group: { account: '!group', domain: 'local', namespaceId: 0 },
      member: {
        account: 'remote',
        domain: 'peer.test',
        namespaceId: 5,
      },
      expectedAuthorizationEpoch: 8,
    });
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
      {} as never,
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

  it('routes a mirror sweep child to the mirror disband revocation', async () => {
    const revokeMember = vi.fn().mockResolvedValue({ transitioned: true });
    const execute = vi.fn();
    const handler = new ForceRevokeGroupMemberTaskHandler(
      new DurableTaskDispatcherService(),
      { execute } as never,
      { revokeMember } as never,
      {} as never,
      {} as never,
    );
    const child = {
      ...parent,
      id: 11n,
      taskType: 'FORCE_REVOKE_GROUP_MEMBER',
      payload: {
        threadId: 12,
        direction: 'MIRROR',
        memberUserId: 7,
        expectedAuthorizationEpoch: 10,
      },
    } satisfies DurableTask;

    await handler.execute(child);

    expect(revokeMember).toHaveBeenCalledWith({
      threadId: 12,
      memberUserId: 7,
      expectedAuthorizationEpoch: 10,
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('marks the mirror tombstone, then sweeps local members through the shared cursor', async () => {
    const dispatcher = new DurableTaskDispatcherService();
    const markDissolved = vi.fn().mockResolvedValue({ transitioned: true });
    const insertNextMember = vi
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const handler = new DisbandMirrorGroupMembersTaskHandler(
      dispatcher,
      { markDissolved } as never,
      { insertNextMember } as never,
    );
    handler.onModuleInit();
    const task = {
      ...parent,
      taskType: 'DISBAND_MIRROR_GROUP_MEMBERS',
      payload: {
        threadId: 12,
        groupAccount: '!group',
        peerDomain: 'peer.test',
        namespaceId: 5,
        expectedAuthorizationEpoch: 9,
      },
    };

    await dispatcher.execute(task);

    expect(markDissolved).toHaveBeenCalledWith({
      threadId: 12,
      groupAccount: '!group',
      peerDomain: 'peer.test',
      namespaceId: 5,
      expectedAuthorizationEpoch: 9,
    });
    expect(insertNextMember).toHaveBeenCalledTimes(2);
    expect(insertNextMember).toHaveBeenCalledWith(task, 12);
    handler.onModuleDestroy();
    expect(dispatcher.supportedTaskTypes).toHaveLength(0);
  });
});
