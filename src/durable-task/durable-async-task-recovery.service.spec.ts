import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DurableAsyncTaskRecoveryService } from './durable-async-task-recovery.service.js';
import type { DurableAsyncTaskSchedulerService } from './durable-async-task-scheduler.service.js';
import type { DurableTaskStoreService } from './durable-task-store.service.js';
import type { DurableTask } from './durable-task.types.js';

const recoveredTask = {
  id: 9n,
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

afterEach(() => vi.restoreAllMocks());

describe('DurableAsyncTaskRecoveryService', () => {
  it('restores async rows for handlers registered at bootstrap', async () => {
    const findAsyncProcessing = vi.fn().mockResolvedValue([recoveredTask]);
    const store = { findAsyncProcessing } as unknown as DurableTaskStoreService;
    const enqueue = vi.fn();
    const scheduler = {
      supportedTaskTypes: ['SYNC_GROUP_META'],
      enqueue,
    } as unknown as DurableAsyncTaskSchedulerService;
    const recovery = new DurableAsyncTaskRecoveryService(store, scheduler);

    await recovery.onApplicationBootstrap();

    expect(findAsyncProcessing).toHaveBeenCalledWith(['SYNC_GROUP_META']);
    expect(enqueue).toHaveBeenCalledWith(recoveredTask);
  });

  it('does not query when no async handler is registered', async () => {
    const findAsyncProcessing = vi.fn();
    const store = { findAsyncProcessing } as unknown as DurableTaskStoreService;
    const scheduler = {
      supportedTaskTypes: [],
      enqueue: vi.fn(),
    } as unknown as DurableAsyncTaskSchedulerService;
    const recovery = new DurableAsyncTaskRecoveryService(store, scheduler);

    await recovery.onApplicationBootstrap();

    expect(findAsyncProcessing).not.toHaveBeenCalled();
  });

  it('continues restoring later rows when one enqueue fails', async () => {
    const laterTask = { ...recoveredTask, id: 10n };
    const store = {
      findAsyncProcessing: vi
        .fn()
        .mockResolvedValue([recoveredTask, laterTask]),
    } as unknown as DurableTaskStoreService;
    const enqueue = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('scheduler unavailable');
      })
      .mockImplementationOnce(() => undefined);
    const scheduler = {
      supportedTaskTypes: ['SYNC_GROUP_META'],
      enqueue,
    } as unknown as DurableAsyncTaskSchedulerService;
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const recovery = new DurableAsyncTaskRecoveryService(store, scheduler);

    await recovery.onApplicationBootstrap();

    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(enqueue).toHaveBeenLastCalledWith(laterTask);
  });
});
