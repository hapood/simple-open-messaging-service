import { Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseService } from '../src/database/database.service.js';
import { durableTask } from '../src/database/schema.js';
import { DurableTaskDispatcherService } from '../src/durable-task/durable-task-dispatcher.service.js';
import { DurableTaskQueueService } from '../src/durable-task/durable-task-queue.service.js';
import { DurableTaskSchedulerService } from '../src/durable-task/durable-task-scheduler.service.js';
import { DurableTaskStoreService } from '../src/durable-task/durable-task-store.service.js';
import { DurableTaskWakeService } from '../src/durable-task/durable-task-wake.service.js';
import type { DurableTask } from '../src/durable-task/durable-task.types.js';
import { truncateTablesForTest } from './support/truncate';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('durable task committed wake and drain', () => {
  let database: DatabaseService;
  let queue: DurableTaskQueueService;
  let store: DurableTaskStoreService;
  let scheduler: DurableTaskSchedulerService;
  let listener: DurableTaskWakeService;
  const execute = vi.fn<(task: DurableTask) => Promise<void>>();
  const input = (payload: Record<string, unknown> = {}) => ({
    scope: {
      type: 'GROUP' as const,
      address: { profileNamespaceId: 0, account: '!wake-test' },
    },
    taskType: 'TEST_COMMAND',
    payload,
  });
  const status = async (id: bigint) =>
    (
      await database.db.query.durableTask.findFirst({
        where: eq(durableTask.id, id),
        columns: { status: true },
      })
    )?.status;
  const waitForStatus = (id: bigint, expected: string) =>
    vi.waitFor(
      async () => {
        expect(await status(id)).toBe(expected);
      },
      { timeout: 5000 },
    );

  beforeEach(async () => {
    database = new DatabaseService();
    await truncateTablesForTest(
      database.pool,
      'TRUNCATE TABLE "DurableTask" RESTART IDENTITY CASCADE',
    );
    store = new DurableTaskStoreService(database);
    queue = new DurableTaskQueueService(database);
    const dispatcher = new DurableTaskDispatcherService();
    execute.mockReset().mockResolvedValue(undefined);
    dispatcher.register({ taskType: 'TEST_COMMAND', execute });
    scheduler = new DurableTaskSchedulerService(store, dispatcher);
    listener = new DurableTaskWakeService(database, scheduler);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    await listener.onModuleDestroy();
    await scheduler.stop();
    await database.onApplicationShutdown();
    vi.restoreAllMocks();
  });

  it('discovers preexisting work, releases failed successors, and stays idle until another commit', async () => {
    execute.mockImplementation(async (task) => {
      if (task.payload.fail) throw new Error('expected task failure');
    });
    const first = await queue.enqueueTask(input({ fail: true }));
    const second = await queue.enqueueTask(input());
    await listener.onApplicationBootstrap();
    await waitForStatus(first.taskId, 'FAILED');
    await waitForStatus(second.taskId, 'SUCCEEDED');
    const discovery = vi.spyOn(store, 'findEligible');
    // Flush delivered completion hints, then cross the former one-second poll.
    await new Promise((resolve) => setTimeout(resolve, 100));
    discovery.mockClear();
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(discovery).not.toHaveBeenCalled();
    const third = await queue.enqueueTask(input());
    await waitForStatus(third.taskId, 'SUCCEEDED');
    expect(execute.mock.calls.map(([task]) => task.id)).toEqual([
      first.taskId,
      second.taskId,
      third.taskId,
    ]);
  });

  it('wakes only after the owning transaction commits and discards rolled-back admissions', async () => {
    await listener.onApplicationBootstrap();
    const staged = deferred();
    const commit = deferred();
    const transaction = database.db.transaction(async (tx) => {
      const task = await queue.enqueueTaskInTx(tx, input());
      staged.resolve();
      await commit.promise;
      return task;
    });
    try {
      await staged.promise;
      const discovery = vi.spyOn(store, 'findEligible');
      await new Promise((resolve) => setTimeout(resolve, 1100));
      expect(discovery).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
    } finally {
      commit.resolve();
    }
    const committed = await transaction;
    await waitForStatus(committed.taskId, 'SUCCEEDED');
    await expect(
      database.db.transaction(async (tx) => {
        await queue.enqueueTaskInTx(tx, input({ rolledBack: true }));
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    const following = await queue.enqueueTask(input());
    await waitForStatus(following.taskId, 'SUCCEEDED');
    expect(execute.mock.calls.map(([task]) => task.id)).toEqual([
      committed.taskId,
      following.taskId,
    ]);
  });

  it('rescans work committed while the listener is disconnected', async () => {
    await listener.onApplicationBootstrap();
    const { rows } = await database.pool.query<{ pid: number }>(
      "SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND application_name = 'durable-task-listener'",
    );
    expect(rows).toHaveLength(1);
    await database.pool.query('SELECT pg_terminate_backend($1)', [rows[0].pid]);
    const task = await queue.enqueueTask(input());
    await waitForStatus(task.taskId, 'SUCCEEDED');
    const reconnected = await database.pool.query<{ pid: number }>(
      "SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND application_name = 'durable-task-listener'",
    );
    expect(reconnected.rows).toHaveLength(1);
    expect(reconnected.rows[0].pid).not.toBe(rows[0].pid);
    expect(execute).toHaveBeenCalledOnce();
  });
});
