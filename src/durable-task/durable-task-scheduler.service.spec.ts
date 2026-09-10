import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BusinessException } from '../common/business.exception.js';
import { DurableAsyncTaskDispatcherService } from './durable-async-task-dispatcher.service.js';
import { DurableAsyncTaskSchedulerService } from './durable-async-task-scheduler.service.js';
import { DurableTaskDispatcherService } from './durable-task-dispatcher.service.js';
import { DurableTaskSchedulerService } from './durable-task-scheduler.service.js';
import type { DurableTaskStoreService } from './durable-task-store.service.js';
import type { DurableTask } from './durable-task.types.js';

function makeTask(id: bigint, scopeKey = `aggregate-${id.toString()}`) {
  return {
    id,
    kind: 'MUTATION',
    scopeType: 'GROUP',
    scopeKey,
    taskType: 'TEST_COMMAND',
    actorUserId: 1,
    payload: {},
    checkpoint: {},
    coalescingKey: null,
    status: 'PENDING',
    resultCode: null,
    lastError: null,
    createdAt: new Date(),
    startedAt: null,
    completedAt: null,
  } satisfies DurableTask;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function createStore(tasks: DurableTask[]) {
  const findCheckpointedProcessing = vi.fn(
    async (taskTypes: readonly string[], limit?: number) =>
      tasks
        .filter(
          ({ status, taskType: candidateType }) =>
            status === 'PROCESSING' && taskTypes.includes(candidateType),
        )
        .slice(0, limit),
  );
  const findEligible = vi.fn(async (_types: readonly string[], limit: number) =>
    tasks.filter(({ status }) => status === 'PENDING').slice(0, limit),
  );
  const claim = vi.fn(async (id: bigint) => {
    const task = tasks.find((candidate) => candidate.id === id);
    if (!task || task.status !== 'PENDING') return undefined;
    task.status = 'PROCESSING';
    task.startedAt = new Date();
    return task;
  });
  const markSucceeded = vi.fn(async (id: bigint) => {
    const task = tasks.find((task) => task.id === id);
    if (!task || task.status !== 'PROCESSING') {
      throw new Error('processing task could not be finalized');
    }
    task.status = 'SUCCEEDED';
  });
  const markAsyncProcessing = vi.fn(async (id: bigint) => {
    const task = tasks.find((candidate) => candidate.id === id);
    if (!task || task.status !== 'PROCESSING') {
      throw new Error('task could not hand off async');
    }
    task.status = 'ASYNC_PROCESSING';
    return task;
  });
  const markRejected = vi.fn(async (id: bigint) => {
    tasks.find((task) => task.id === id)!.status = 'REJECTED';
  });
  const markFailed = vi.fn(async (id: bigint) => {
    tasks.find((task) => task.id === id)!.status = 'FAILED';
  });
  return {
    store: {
      findCheckpointedProcessing,
      findEligible,
      claim,
      markAsyncProcessing,
      markSucceeded,
      markRejected,
      markFailed,
    } as unknown as DurableTaskStoreService,
    markSucceeded,
    markAsyncProcessing,
    markRejected,
    markFailed,
  };
}

function createAsyncScheduler(store: DurableTaskStoreService) {
  return new DurableAsyncTaskSchedulerService(
    new DurableAsyncTaskDispatcherService(),
    store,
  );
}

const savedConcurrency = process.env.DURABLE_TASK_MAX_CONCURRENCY;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (savedConcurrency === undefined) {
    delete process.env.DURABLE_TASK_MAX_CONCURRENCY;
  } else {
    process.env.DURABLE_TASK_MAX_CONCURRENCY = savedConcurrency;
  }
});

describe('DurableTaskSchedulerService', () => {
  it('stays idle without a timer after draining and resumes on a new wake', async () => {
    vi.useFakeTimers();
    const tasks: DurableTask[] = [];
    const harness = createStore(tasks);
    const dispatcher = new DurableTaskDispatcherService();
    const execute = vi.fn(async () => {});
    dispatcher.register({ taskType: 'TEST_COMMAND', execute });
    const scheduler = new DurableTaskSchedulerService(
      harness.store,
      dispatcher,
      createAsyncScheduler(harness.store),
    );
    await scheduler.wake();
    const idleQueries = vi.mocked(harness.store.findEligible).mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.store.findEligible).toHaveBeenCalledTimes(idleQueries);
    expect(vi.getTimerCount()).toBe(0);
    tasks.push(makeTask(1n));
    await scheduler.wake();
    await vi.advanceTimersByTimeAsync(0);
    expect(execute).toHaveBeenCalledOnce();
    expect(tasks[0].status).toBe('SUCCEEDED');
    const drainedQueries = vi.mocked(harness.store.findEligible).mock.calls
      .length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.store.findEligible).toHaveBeenCalledTimes(drainedQueries);
    expect(vi.getTimerCount()).toBe(0);
    await scheduler.stop();
  });

  it('preserves a wake arriving during an empty discovery query', async () => {
    const tasks: DurableTask[] = [];
    const harness = createStore(tasks);
    const gate = deferred();
    vi.mocked(harness.store.findEligible).mockImplementationOnce(async () => {
      await gate.promise;
      return [];
    });
    const dispatcher = new DurableTaskDispatcherService();
    const execute = vi.fn(async () => {});
    dispatcher.register({ taskType: 'TEST_COMMAND', execute });
    const scheduler = new DurableTaskSchedulerService(
      harness.store,
      dispatcher,
      createAsyncScheduler(harness.store),
    );
    const pump = scheduler.wake();
    await vi.waitFor(() =>
      expect(harness.store.findEligible).toHaveBeenCalledOnce(),
    );
    tasks.push(makeTask(1n));
    void scheduler.wake();
    gate.resolve();
    await pump;
    await vi.waitFor(() =>
      expect(harness.markSucceeded).toHaveBeenCalledOnce(),
    );
    expect(execute).toHaveBeenCalledOnce();
    await scheduler.stop();
  });

  it.each(['findCheckpointedProcessing', 'findEligible', 'claim'] as const)(
    'retries a failed %s query without spinning, then stops after draining',
    async (method) => {
      vi.useFakeTimers();
      vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const harness = createStore([makeTask(1n)]);
      vi.mocked(harness.store[method]).mockRejectedValueOnce(
        new Error('database unavailable'),
      );
      const dispatcher = new DurableTaskDispatcherService();
      const execute = vi.fn(async () => {});
      dispatcher.register({ taskType: 'TEST_COMMAND', execute });
      const scheduler = new DurableTaskSchedulerService(
        harness.store,
        dispatcher,
        createAsyncScheduler(harness.store),
      );
      await scheduler.wake();
      expect(harness.store[method]).toHaveBeenCalledOnce();
      expect(execute).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(1000);
      expect(execute).toHaveBeenCalledOnce();
      expect(harness.markSucceeded).toHaveBeenCalledWith(1n);
      expect(vi.getTimerCount()).toBe(0);
      await scheduler.stop();
    },
  );

  it('cancels discovery recovery on shutdown', async () => {
    vi.useFakeTimers();
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const harness = createStore([]);
    vi.mocked(harness.store.findEligible).mockRejectedValue(
      new Error('database unavailable'),
    );
    const scheduler = new DurableTaskSchedulerService(
      harness.store,
      new DurableTaskDispatcherService(),
      createAsyncScheduler(harness.store),
    );
    await scheduler.wake();
    expect(vi.getTimerCount()).toBe(1);
    await scheduler.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.store.findEligible).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('captures recovery once and drains it across concurrency-limited batches', async () => {
    process.env.DURABLE_TASK_MAX_CONCURRENCY = '1';
    const tasks = [1n, 2n, 3n].map((id) => ({
      ...makeTask(id),
      taskType: 'FAN_OUT_GROUP_META_HEAD',
      status: 'PROCESSING' as const,
    }));
    const harness = createStore(tasks);
    const gates = tasks.map(() => deferred());
    const dispatcher = new DurableTaskDispatcherService();
    const execute = vi.fn(
      (task: DurableTask) => gates[Number(task.id) - 1].promise,
    );
    dispatcher.register({ taskType: 'FAN_OUT_GROUP_META_HEAD', execute });
    const scheduler = new DurableTaskSchedulerService(
      harness.store,
      dispatcher,
      createAsyncScheduler(harness.store),
    );
    await scheduler.wake();
    expect(execute).toHaveBeenCalledTimes(1);
    for (let index = 0; index < tasks.length; index += 1) {
      gates[index].resolve();
      await vi.waitFor(() =>
        expect(harness.markSucceeded).toHaveBeenCalledTimes(index + 1),
      );
      await scheduler.wake();
      expect(execute).toHaveBeenCalledTimes(Math.min(index + 2, tasks.length));
    }
    expect(harness.store.findCheckpointedProcessing).toHaveBeenCalledOnce();
    await scheduler.onApplicationShutdown();
  });

  it.each(['FAN_OUT_THREAD_CONTENT', 'FAN_OUT_FEDERATION_THREAD_CONTENT'])(
    'recovers interrupted %s at startup',
    async (taskType) => {
      const task = {
        ...makeTask(1n),
        taskType,
        status: 'PROCESSING' as const,
      };
      const harness = createStore([task]);
      const dispatcher = new DurableTaskDispatcherService();
      const execute = vi.fn(async () => {});
      dispatcher.register({ taskType: task.taskType, execute });
      const scheduler = new DurableTaskSchedulerService(
        harness.store,
        dispatcher,
        createAsyncScheduler(harness.store),
      );
      await scheduler.wake();
      await vi.waitFor(() =>
        expect(harness.markSucceeded).toHaveBeenCalledOnce(),
      );
      expect(harness.store.findCheckpointedProcessing).toHaveBeenCalledWith(
        expect.arrayContaining([taskType]),
      );
      expect(execute).toHaveBeenCalledOnce();
      await scheduler.onApplicationShutdown();
    },
  );

  it('does not scan locally executing tasks for recovery on subsequent wakes', async () => {
    const task = { ...makeTask(1n), taskType: 'FAN_OUT_GROUP_META_HEAD' };
    const harness = createStore([task]);
    const gate = deferred();
    const dispatcher = new DurableTaskDispatcherService();
    const execute = vi.fn(() => gate.promise);
    dispatcher.register({ taskType: task.taskType, execute });
    const scheduler = new DurableTaskSchedulerService(
      harness.store,
      dispatcher,
      createAsyncScheduler(harness.store),
    );
    await scheduler.wake();
    await scheduler.wake();
    gate.resolve();
    await vi.waitFor(() =>
      expect(harness.markSucceeded).toHaveBeenCalledOnce(),
    );
    await scheduler.wake();
    expect(harness.store.findCheckpointedProcessing).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
    await scheduler.onApplicationShutdown();
  });

  it('waits for an active execution and its terminal write during shutdown', async () => {
    const task = makeTask(1n);
    const harness = createStore([task]);
    const gate = deferred();
    const dispatcher = new DurableTaskDispatcherService();
    dispatcher.register({
      taskType: 'TEST_COMMAND',
      execute: () => gate.promise,
    });
    const scheduler = new DurableTaskSchedulerService(
      harness.store,
      dispatcher,
      createAsyncScheduler(harness.store),
    );
    await scheduler.wake();

    let stopped = false;
    const stop = scheduler.stop();
    expect(scheduler.stop()).toBe(stop);
    expect(scheduler.onApplicationShutdown()).toBe(stop);
    const shutdown = stop.then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);

    gate.resolve();
    await shutdown;
    expect(harness.markSucceeded).toHaveBeenCalledWith(task.id);
    expect(stopped).toBe(true);
  });

  it.each([
    'DISBAND_GROUP',
    'REVOKE_FORBIDDEN_GROUP',
    'FORCE_REVOKE_GROUP_MEMBER',
  ])(
    'resumes interrupted %s and projection tasks already in processing',
    async (taskType) => {
      const disband = {
        ...makeTask(1n, 'group-key'),
        taskType,
        status: 'PROCESSING',
        startedAt: new Date(),
      } satisfies DurableTask;
      const projection = {
        ...makeTask(2n, 'other-group-key'),
        kind: 'PROJECTION',
        taskType: 'FAN_OUT_GROUP_META_HEAD',
        status: 'PROCESSING',
        startedAt: new Date(),
      } satisfies DurableTask;
      const harness = createStore([disband, projection]);
      const dispatcher = new DurableTaskDispatcherService();
      const execute = vi.fn().mockResolvedValue(undefined);
      dispatcher.register({ taskType, execute });
      dispatcher.register({ taskType: 'FAN_OUT_GROUP_META_HEAD', execute });
      const scheduler = new DurableTaskSchedulerService(
        harness.store,
        dispatcher,
        createAsyncScheduler(harness.store),
      );

      await scheduler.wake();
      await vi.waitFor(() =>
        expect(harness.markSucceeded).toHaveBeenCalledTimes(2),
      );

      expect(execute).toHaveBeenCalledWith(disband);
      expect(execute).toHaveBeenCalledWith(projection);
    },
  );

  it('bounds unrelated task execution and refills released slots', async () => {
    process.env.DURABLE_TASK_MAX_CONCURRENCY = '2';
    const tasks = [makeTask(1n), makeTask(2n), makeTask(3n)];
    const harness = createStore(tasks);
    const dispatcher = new DurableTaskDispatcherService();
    const gates = new Map(tasks.map(({ id }) => [id, deferred()]));
    const execute = vi.fn((task: DurableTask) => gates.get(task.id)!.promise);
    dispatcher.register({ taskType: 'TEST_COMMAND', execute });
    const scheduler = new DurableTaskSchedulerService(
      harness.store,
      dispatcher,
      createAsyncScheduler(harness.store),
    );

    await scheduler.wake();
    expect(execute).toHaveBeenCalledTimes(2);
    expect(tasks.map(({ status }) => status)).toEqual([
      'PROCESSING',
      'PROCESSING',
      'PENDING',
    ]);

    gates.get(1n)!.resolve();
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(3));
    expect(tasks[2].status).toBe('PROCESSING');

    gates.get(2n)!.resolve();
    gates.get(3n)!.resolve();
    await vi.waitFor(() =>
      expect(harness.markSucceeded).toHaveBeenCalledTimes(3),
    );
  });

  it('does not block a projection behind the mutation lane for the same scope', async () => {
    process.env.DURABLE_TASK_MAX_CONCURRENCY = '2';
    const mutation = makeTask(1n, 'shared-group');
    const projection = {
      ...makeTask(2n, 'shared-group'),
      kind: 'PROJECTION',
      taskType: 'FAN_OUT_GROUP_META_HEAD',
    } satisfies DurableTask;
    const tasks = [mutation, projection];
    const harness = createStore(tasks);
    const dispatcher = new DurableTaskDispatcherService();
    const gates = new Map(tasks.map(({ id }) => [id, deferred()]));
    const execute = vi.fn((task: DurableTask) => gates.get(task.id)!.promise);
    dispatcher.register({ taskType: 'TEST_COMMAND', execute });
    dispatcher.register({ taskType: 'FAN_OUT_GROUP_META_HEAD', execute });
    const scheduler = new DurableTaskSchedulerService(
      harness.store,
      dispatcher,
      createAsyncScheduler(harness.store),
    );

    await scheduler.wake();
    expect(execute).toHaveBeenCalledTimes(2);

    gates.get(1n)!.resolve();
    gates.get(2n)!.resolve();
    await vi.waitFor(() =>
      expect(harness.markSucceeded).toHaveBeenCalledTimes(2),
    );
  });

  it('maps business refusals and sanitized unexpected failures to terminal states', async () => {
    const tasks = [makeTask(1n), makeTask(2n), makeTask(3n)];
    const harness = createStore(tasks);
    const dispatcher = new DurableTaskDispatcherService();
    dispatcher.register({
      taskType: 'TEST_COMMAND',
      execute: async ({ id }) => {
        if (id === 2n) {
          throw new BusinessException(20010, 'invite missing');
        }
        if (id === 3n) {
          throw Object.assign(new Error('secret remote response'), {
            code: 'ECONNRESET',
          });
        }
      },
    });
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const scheduler = new DurableTaskSchedulerService(
      harness.store,
      dispatcher,
      createAsyncScheduler(harness.store),
    );

    await scheduler.wake();
    await vi.waitFor(() => expect(harness.markFailed).toHaveBeenCalledOnce());
    expect(harness.markSucceeded).toHaveBeenCalledWith(1n);
    expect(harness.markRejected).toHaveBeenCalledWith(2n, 20010);
    expect(harness.markFailed).toHaveBeenCalledWith(
      3n,
      'Unexpected task error (Error, code ECONNRESET)',
    );
    expect(harness.markFailed.mock.calls[0][1]).not.toContain('secret');
  });

  it('hands async work off durably and releases the ordinary execution slot', async () => {
    process.env.DURABLE_TASK_MAX_CONCURRENCY = '1';
    const asyncTask = makeTask(1n, 'async-group');
    const followingTask = makeTask(2n, 'other-group');
    const harness = createStore([asyncTask, followingTask]);
    const dispatcher = new DurableTaskDispatcherService();
    dispatcher.register({
      taskType: 'TEST_COMMAND',
      execute: async ({ id }) =>
        id === asyncTask.id ? { status: 'ASYNC_PROCESSING' } : undefined,
    });
    const executeAsync = vi.fn().mockResolvedValue(undefined);
    const asyncDispatcher = new DurableAsyncTaskDispatcherService();
    asyncDispatcher.register({
      taskType: 'TEST_COMMAND',
      execute: executeAsync,
    });
    const asyncScheduler = new DurableAsyncTaskSchedulerService(
      asyncDispatcher,
      harness.store,
    );
    const scheduler = new DurableTaskSchedulerService(
      harness.store,
      dispatcher,
      asyncScheduler,
    );

    await scheduler.wake();
    await vi.waitFor(() => expect(executeAsync).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(harness.markSucceeded).toHaveBeenCalledWith(followingTask.id),
    );

    expect(harness.markAsyncProcessing).toHaveBeenCalledWith(asyncTask.id);
    expect(executeAsync).toHaveBeenCalledWith(asyncTask);
    expect(asyncTask.status).toBe('ASYNC_PROCESSING');
    expect(harness.markSucceeded).not.toHaveBeenCalledWith(asyncTask.id);
  });

  it('resumes an async-capable task that stopped before durable handoff', async () => {
    const task = {
      ...makeTask(1n),
      status: 'PROCESSING',
      startedAt: new Date(),
    } satisfies DurableTask;
    const harness = createStore([task]);
    const dispatcher = new DurableTaskDispatcherService();
    const execute = vi.fn().mockResolvedValue({
      status: 'ASYNC_PROCESSING' as const,
    });
    dispatcher.register({ taskType: 'TEST_COMMAND', execute });
    const executeAsync = vi.fn().mockResolvedValue(undefined);
    const asyncDispatcher = new DurableAsyncTaskDispatcherService();
    asyncDispatcher.register({
      taskType: 'TEST_COMMAND',
      execute: executeAsync,
    });
    const asyncScheduler = new DurableAsyncTaskSchedulerService(
      asyncDispatcher,
      harness.store,
    );
    const scheduler = new DurableTaskSchedulerService(
      harness.store,
      dispatcher,
      asyncScheduler,
    );

    await scheduler.wake();
    await vi.waitFor(() => expect(executeAsync).toHaveBeenCalledWith(task));

    expect(execute).toHaveBeenCalledWith(task);
    expect(harness.markAsyncProcessing).toHaveBeenCalledWith(task.id);
  });
});
