import { describe, expect, it, vi } from 'vitest';
import { DurableAsyncTaskDispatcherService } from '../durable-task/durable-async-task-dispatcher.service.js';
import { DurableTaskDispatcherService } from '../durable-task/durable-task-dispatcher.service.js';
import type { DurableTask } from '../durable-task/durable-task.types.js';
import {
  GroupMetaSyncAsyncTaskHandler,
  GroupMetaSyncHandoffTaskHandler,
} from './group-meta-sync-task.handlers.js';

const task = {
  id: 4n,
  parentTaskId: null,
  kind: 'PROJECTION',
  scopeType: 'GROUP',
  scopeKey: 'group:8',
  taskType: 'SYNC_GROUP_META',
  actorUserId: null,
  payload: {
    groupId: 8,
    groupAccount: '!group',
    peerDomain: 'peer.test',
    namespaceId: 3,
    through: '20',
  },
  checkpoint: {
    phase: 'PULL',
    mode: 'delta',
    after: '10',
    through: '20',
  },
  coalescingKey: 'group-meta',
  supersededByTaskId: null,
  status: 'PROCESSING',
  resultCode: null,
  lastError: null,
  createdAt: new Date(),
  startedAt: new Date(),
  completedAt: null,
} satisfies DurableTask;

describe('group-meta sync task handlers', () => {
  it('hands ordinary execution off to the async runner', async () => {
    const dispatcher = new DurableTaskDispatcherService();
    const handler = new GroupMetaSyncHandoffTaskHandler(dispatcher);
    handler.onModuleInit();

    await expect(dispatcher.execute(task)).resolves.toEqual({
      status: 'ASYNC_PROCESSING',
    });

    handler.onModuleDestroy();
    expect(dispatcher.supportedTaskTypes).toEqual([]);
  });

  it('registers async execution and delegates the durable task', async () => {
    const dispatcher = new DurableAsyncTaskDispatcherService();
    const execute = vi.fn().mockResolvedValue({
      clientFeedUpdates: [{ userId: 2, feedId: 9 }],
      statePushDomains: ['peer.test'],
    });
    const notifyFeedUpdates = vi.fn();
    const emit = vi.fn();
    const handler = new GroupMetaSyncAsyncTaskHandler(
      dispatcher,
      {
        execute,
      } as never,
      { notifyFeedUpdates } as never,
      { emit } as never,
    );
    handler.onModuleInit();
    const asyncTask = { ...task, status: 'ASYNC_PROCESSING' as const };

    await dispatcher.execute(asyncTask);

    expect(execute).toHaveBeenCalledWith(asyncTask);
    expect(notifyFeedUpdates).toHaveBeenCalledWith([
      { userId: 2, feedId: 9 },
    ]);
    expect(emit).toHaveBeenCalledWith('federation.state-feed.push', {
      peerDomain: 'peer.test',
    });
    handler.onModuleDestroy();
    expect(dispatcher.supportedTaskTypes).toEqual([]);
  });

  it('does not wake State Feed before the async task succeeds', async () => {
    const dispatcher = new DurableAsyncTaskDispatcherService();
    const emit = vi.fn();
    const handler = new GroupMetaSyncAsyncTaskHandler(
      dispatcher,
      { execute: vi.fn().mockRejectedValue(new Error('failed')) } as never,
      { notifyFeedUpdates: vi.fn() } as never,
      { emit } as never,
    );
    handler.onModuleInit();

    await expect(
      dispatcher.execute({ ...task, status: 'ASYNC_PROCESSING' }),
    ).rejects.toThrow('failed');

    expect(emit).not.toHaveBeenCalled();
  });
});
