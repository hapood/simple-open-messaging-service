import { Logger } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { beginDatabaseRoundTrip } from '../diagnostics/execution-measurement.js';
import { DurableTaskDispatcherService } from './durable-task-dispatcher.service.js';
import type { DurableTask } from './durable-task.types.js';

const task = {
  id: 1n,
  kind: 'MUTATION',
  scopeType: 'GROUP',
  scopeKey: 'group-key',
  taskType: 'DISBAND_GROUP',
  actorUserId: 1,
  payload: {},
  checkpoint: {},
  coalescingKey: null,
  status: 'PROCESSING',
  resultCode: null,
  lastError: null,
  createdAt: new Date(),
  startedAt: new Date(),
  completedAt: null,
} satisfies DurableTask;

describe('DurableTaskDispatcherService', () => {
  it('registers, executes, and unregisters a handler', async () => {
    const dispatcher = new DurableTaskDispatcherService();
    const execute = vi.fn(async () => undefined);
    const unregister = dispatcher.register({
      taskType: 'DISBAND_GROUP',
      execute,
    });

    expect(dispatcher.supportedTaskTypes).toEqual(['DISBAND_GROUP']);
    await dispatcher.execute(task);
    expect(execute).toHaveBeenCalledWith(task);

    unregister();
    expect(dispatcher.supportedTaskTypes).toEqual([]);
    await expect(dispatcher.execute(task)).rejects.toThrow(
      'no handler registered',
    );
  });

  it('rejects invalid and duplicate registrations', () => {
    const dispatcher = new DurableTaskDispatcherService();
    const handler = {
      taskType: 'DISBAND_GROUP',
      execute: async () => undefined,
    };
    dispatcher.register(handler);

    expect(() => dispatcher.register(handler)).toThrow('already registered');
    expect(() =>
      dispatcher.register({ ...handler, taskType: 'disband-group' }),
    ).toThrow(TypeError);
  });

  it('establishes a measured task execution context when sampled', async () => {
    const previousSampleRate = process.env.EXECUTION_MEASUREMENT_SAMPLE_RATE;
    process.env.EXECUTION_MEASUREMENT_SAMPLE_RATE = '1';
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    try {
      const dispatcher = new DurableTaskDispatcherService();
      dispatcher.register({
        taskType: 'DISBAND_GROUP',
        execute: async () => {
          const finish = beginDatabaseRoundTrip();
          expect(finish).toBeTypeOf('function');
          finish?.();
        },
      });

      await dispatcher.execute(task);

      expect(log).toHaveBeenCalledWith(
        expect.objectContaining({
          executionId: 'task:1',
          kind: 'task',
          name: 'DISBAND_GROUP',
          taskId: '1',
          databaseRoundTripCount: 1,
        }),
      );
    } finally {
      log.mockRestore();
      if (previousSampleRate === undefined)
        delete process.env.EXECUTION_MEASUREMENT_SAMPLE_RATE;
      else process.env.EXECUTION_MEASUREMENT_SAMPLE_RATE = previousSampleRate;
    }
  });
});
