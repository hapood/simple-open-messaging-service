import { describe, expect, it, vi } from 'vitest';
import { DurableAsyncTaskDispatcherService } from './durable-async-task-dispatcher.service.js';
import type { DurableTask } from './durable-task.types.js';

const asyncTask = {
  id: 1n,
  kind: 'PROJECTION',
  scopeType: 'GROUP',
  scopeKey: 'group-key',
  taskType: 'SYNC_GROUP_META',
  actorUserId: null,
  payload: {},
  checkpoint: {},
  coalescingKey: null,
  status: 'ASYNC_PROCESSING',
  resultCode: null,
  lastError: null,
  createdAt: new Date(),
  startedAt: new Date(),
  completedAt: null,
} satisfies DurableTask;

describe('DurableAsyncTaskDispatcherService', () => {
  it('registers and dispatches an async task handler', async () => {
    const dispatcher = new DurableAsyncTaskDispatcherService();
    const execute = vi.fn().mockResolvedValue(undefined);
    const unregister = dispatcher.register({
      taskType: 'SYNC_GROUP_META',
      execute,
    });

    expect(dispatcher.supportedTaskTypes).toEqual(['SYNC_GROUP_META']);
    await dispatcher.execute(asyncTask);
    expect(execute).toHaveBeenCalledWith(asyncTask);

    unregister();
    expect(dispatcher.supportedTaskTypes).toEqual([]);
    await expect(dispatcher.execute(asyncTask)).rejects.toThrow(
      'no async handler registered',
    );
  });

  it('rejects invalid registrations and non-async rows', async () => {
    const dispatcher = new DurableAsyncTaskDispatcherService();
    const handler = {
      taskType: 'SYNC_GROUP_META',
      execute: vi.fn().mockResolvedValue(undefined),
    };
    dispatcher.register(handler);

    expect(() => dispatcher.register(handler)).toThrow('already registered');
    expect(() =>
      dispatcher.register({ ...handler, taskType: 'sync-group-meta' }),
    ).toThrow('invalid async durable task type');
    await expect(
      dispatcher.execute({ ...asyncTask, status: 'PROCESSING' }),
    ).rejects.toThrow('only ASYNC_PROCESSING tasks');
  });
});
