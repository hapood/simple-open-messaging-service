import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DurableAsyncTaskDispatcherService } from './durable-async-task-dispatcher.service.js';
import { DurableAsyncTaskSchedulerService } from './durable-async-task-scheduler.service.js';
import type { DurableTaskStoreService } from './durable-task-store.service.js';
import type { DurableTask } from './durable-task.types.js';

function makeTask(id: bigint): DurableTask {
  return {
    id,
    parentTaskId: null,
    kind: 'PROJECTION',
    scopeType: 'GROUP',
    scopeKey: `group-${id.toString()}`,
    taskType: 'SYNC_GROUP_META',
    actorUserId: null,
    payload: {},
    checkpoint: {},
    coalescingKey: null,
    supersededByTaskId: null,
    status: 'ASYNC_PROCESSING',
    resultCode: null,
    lastError: null,
    createdAt: new Date(),
    startedAt: new Date(),
    completedAt: null,
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const savedConcurrency = process.env.DURABLE_ASYNC_TASK_MAX_CONCURRENCY;

afterEach(() => {
  vi.restoreAllMocks();
  if (savedConcurrency === undefined) {
    delete process.env.DURABLE_ASYNC_TASK_MAX_CONCURRENCY;
  } else {
    process.env.DURABLE_ASYNC_TASK_MAX_CONCURRENCY = savedConcurrency;
  }
});

describe('DurableAsyncTaskSchedulerService', () => {
  it('uses an independent concurrency limit and refills released slots', async () => {
    process.env.DURABLE_ASYNC_TASK_MAX_CONCURRENCY = '2';
    const tasks = [makeTask(1n), makeTask(2n), makeTask(3n)];
    const gates = new Map(tasks.map(({ id }) => [id, deferred()]));
    const dispatcher = new DurableAsyncTaskDispatcherService();
    const execute = vi.fn((task: DurableTask) => gates.get(task.id)!.promise);
    dispatcher.register({ taskType: 'SYNC_GROUP_META', execute });
    const store = {
      markAsyncFailed: vi.fn(),
    } as unknown as DurableTaskStoreService;
    const scheduler = new DurableAsyncTaskSchedulerService(dispatcher, store);

    for (const task of tasks) scheduler.enqueue(task);
    expect(execute).toHaveBeenCalledTimes(2);

    gates.get(1n)!.resolve();
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(3));

    gates.get(2n)!.resolve();
    gates.get(3n)!.resolve();
    await vi.waitFor(() => expect(execute).toHaveBeenLastCalledWith(tasks[2]));
  });

  it('marks an unexpected handler failure terminal without leaking details', async () => {
    const dispatcher = new DurableAsyncTaskDispatcherService();
    dispatcher.register({
      taskType: 'SYNC_GROUP_META',
      execute: async () => {
        throw Object.assign(new Error('secret peer response'), {
          code: 'ECONNRESET',
        });
      },
    });
    const markAsyncFailed = vi.fn().mockResolvedValue(undefined);
    const store = { markAsyncFailed } as unknown as DurableTaskStoreService;
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const scheduler = new DurableAsyncTaskSchedulerService(dispatcher, store);

    scheduler.enqueue(makeTask(4n));

    await vi.waitFor(() => expect(markAsyncFailed).toHaveBeenCalledOnce());
    expect(markAsyncFailed).toHaveBeenCalledWith(
      4n,
      'Unexpected task error (Error, code ECONNRESET)',
    );
    expect(markAsyncFailed.mock.calls[0][1]).not.toContain('secret');
  });

  it('rejects non-async rows and leaves new durable work for recovery after shutdown', async () => {
    const dispatcher = new DurableAsyncTaskDispatcherService();
    const execute = vi.fn();
    dispatcher.register({ taskType: 'SYNC_GROUP_META', execute });
    const scheduler = new DurableAsyncTaskSchedulerService(
      dispatcher,
      {} as DurableTaskStoreService,
    );

    expect(() =>
      scheduler.enqueue({ ...makeTask(1n), status: 'PROCESSING' }),
    ).toThrow('only ASYNC_PROCESSING tasks');

    await scheduler.onApplicationShutdown();
    expect(() => scheduler.enqueue(makeTask(2n))).not.toThrow();
    expect(execute).not.toHaveBeenCalled();
  });

  it('waits for an active execution during shutdown', async () => {
    const gate = deferred();
    const dispatcher = new DurableAsyncTaskDispatcherService();
    dispatcher.register({
      taskType: 'SYNC_GROUP_META',
      execute: () => gate.promise,
    });
    const scheduler = new DurableAsyncTaskSchedulerService(
      dispatcher,
      {} as DurableTaskStoreService,
    );
    scheduler.enqueue(makeTask(1n));

    let stopped = false;
    const shutdown = scheduler.onApplicationShutdown().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);

    gate.resolve();
    await shutdown;
    expect(stopped).toBe(true);
  });
});
